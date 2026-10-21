-- ADDITIVE : collection, lectures (D§7.3, D§9.3, D§9.4, R§3.3) — compteurs par rareté, index, pages stables, stats, collection d'un profil, défausse hors grand livre (C5), solde. Idempotente.

create extension if not exists unaccent with schema extensions;

create index if not exists user_cards_user_obtained_idx on public.user_cards (user_id, obtained_at desc, id);
create index if not exists user_cards_user_rarity_idx on public.user_cards (user_id, snapshot_rarity desc, obtained_at desc, id);
create index if not exists user_cards_card_user_idx on public.user_cards (card_id, user_id);
create index if not exists user_cards_starred_idx on public.user_cards (user_id) where starred;
create index if not exists wishlist_items_card_id_idx on public.wishlist_items (card_id);

-- Lignes et copies (Σ count) par joueur, rareté figée et brillance : totaux et stats sans parcourir user_cards.
create table if not exists wm.user_rarity_counts (
  user_id uuid references public.profiles (id) on delete cascade,
  snapshot_rarity public.rarity,
  is_shiny boolean,
  rows int not null default 0,
  copies int not null default 0,
  primary key (user_id, snapshot_rarity, is_shiny)
);

-- Delta d'une clé, type propre au trigger : user_rarity_counts peut gagner des colonnes sans casser les écritures de user_cards.
do $$ begin
  if to_regtype('wm.rarity_delta') is null then
    create type wm.rarity_delta as (user_id uuid, snapshot_rarity public.rarity, is_shiny boolean, rows int, copies int);
  end if;
end $$;

-- Deltas groupés par clé (+ nouvelles lignes, − anciennes), puis un seul upsert ; une mise à jour qui ne touche pas les clés (starred) n'écrit rien.
create or replace function wm.sync_rarity_counts()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d wm.rarity_delta[] := '{}';
begin
  if tg_op <> 'DELETE' then
    d := array(select (n.user_id, n.snapshot_rarity, n.is_shiny, count(*), sum(n.count))::wm.rarity_delta
               from new_t n group by n.user_id, n.snapshot_rarity, n.is_shiny);
  end if;
  if tg_op <> 'INSERT' then
    d := d || array(select (o.user_id, o.snapshot_rarity, o.is_shiny, -count(*), -sum(o.count))::wm.rarity_delta
                    from old_t o group by o.user_id, o.snapshot_rarity, o.is_shiny);
  end if;
  -- Clés triées : deux instructions concurrentes verrouillent les compteurs dans le même ordre. Profil supprimé (cascade) : plus rien à tenir.
  insert into wm.user_rarity_counts as r (user_id, snapshot_rarity, is_shiny, rows, copies)
  select x.user_id, x.snapshot_rarity, x.is_shiny, sum(x.rows), sum(x.copies) from unnest(d) x
  where exists (select from public.profiles p where p.id = x.user_id)
  group by 1, 2, 3 having sum(x.rows) <> 0 or sum(x.copies) <> 0 order by 1, 2, 3
  on conflict (user_id, snapshot_rarity, is_shiny) do update set rows = r.rows + excluded.rows, copies = r.copies + excluded.copies;
  return null;
end $$;

-- Un trigger par événement : PG refuse les tables de transition sur un trigger multi-événements ou à liste de colonnes.
create or replace trigger user_cards_rarity_counts_ins after insert on public.user_cards
  referencing new table as new_t for each statement execute function wm.sync_rarity_counts();
create or replace trigger user_cards_rarity_counts_upd after update on public.user_cards
  referencing old table as old_t new table as new_t for each statement execute function wm.sync_rarity_counts();
create or replace trigger user_cards_rarity_counts_del after delete on public.user_cards
  referencing old table as old_t for each statement execute function wm.sync_rarity_counts();

-- Remplissage initial sous verrou (triggers déjà posés) : on vide puis on recalcule, car un trigger a pu écrire avant le verrou.
-- lock_timeout : échouer plutôt que bloquer toutes les écritures en file derrière le verrou. delete, pas truncate : les lecteurs ne sont pas bloqués.
do $$ begin
  set local lock_timeout = '5s';
  lock table public.user_cards in share mode;
  delete from wm.user_rarity_counts where true;
  insert into wm.user_rarity_counts (user_id, snapshot_rarity, is_shiny, rows, copies)
  select user_id, snapshot_rarity, is_shiny, count(*), sum(count) from public.user_cards group by 1, 2, 3;
end $$;

-- Fonctions immuables des index, exécutables par tous : les rôles de l'original qui écrivent public.cards doivent pouvoir les évaluer (option A).
create schema if not exists wm_index;
grant usage on schema wm_index to public;

-- Titre + catégorie sans accents ni casse. immutable (unaccent n'est que stable) pour l'index trigramme du catalogue.
-- Corps SQL standard (return) : résolu une fois à la création, l'écrivain n'a besoin d'aucun droit sur le schéma extensions.
create or replace function wm_index.search_text(t text, c text)
returns text language sql immutable parallel safe
return extensions.unaccent('extensions.unaccent'::pg_catalog.regdictionary,
  pg_catalog.lower(t operator(pg_catalog.||) ' ' operator(pg_catalog.||) coalesce(c, '')));
grant execute on function wm_index.search_text(text, text) to public;

-- Clause where (ET) des copies lues par my_collection et my_collection_stats, valeurs en littéraux : le plan ne garde que les filtres posés.
create or replace function wm.collection_filter(p_uid uuid, p_q text, p_rarity public.rarity[], p_tag_id uuid, p_untagged boolean,
  p_wishlisted_by uuid, p_owned_by uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_q text := extensions.unaccent('extensions.unaccent', lower(nullif(btrim(p_q), '')));
begin
  -- shortcut: pas encore d'amis au M1, seuls soi-même et les profils publics passent ; brancher l'amitié avec sa table (D§7.3).
  if coalesce(p_owned_by, p_uid) is distinct from p_uid
     and not coalesce((select is_public from public.profiles where id = p_owned_by), false) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Cette collection est privée');
  end if;
  if coalesce(p_wishlisted_by, p_uid) is distinct from p_uid then
    perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour voir sa liste de souhaits');
  end if;
  return concat_ws(' and ', format('uc.user_id = %L', coalesce(p_owned_by, p_uid)),
    case when v_q is not null then format('strpos(wm_index.search_text(uc.snapshot_title, uc.snapshot_category), %L) > 0', v_q) end,
    case when p_rarity <> '{}' then format('uc.snapshot_rarity = any (%L)', p_rarity) end,
    -- Étiquettes du lecteur seulement, comme les items : celles d'un autre joueur sont privées (RLS) et ne filtrent rien.
    case when p_tag_id is not null then format('exists (select from public.user_card_tags ut join public.tags t on t.id = ut.tag_id
      and t.user_id = %L where ut.user_card_id = uc.id and ut.tag_id = %L)', p_uid, p_tag_id) end,
    case when p_untagged then format('not exists (select from public.user_card_tags ut join public.tags t on t.id = ut.tag_id
      and t.user_id = %L where ut.user_card_id = uc.id)', p_uid) end,
    case when p_wishlisted_by is not null
      then format('uc.card_id in (select w.card_id from public.wishlist_items w where w.user_id = %L)', p_wishlisted_by) end);
end $$;

-- {total, rarities} ; sans autre filtre que la rareté, lu dans user_rarity_counts (O(1)), sinon un comptage groupé sur les mêmes filtres.
create or replace function wm.my_collection_stats(p_uid uuid, p_q text default null, p_rarity public.rarity[] default null,
  p_tag_id uuid default null, p_untagged boolean default false, p_wishlisted_by uuid default null, p_owned_by uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_where text := wm.collection_filter(p_uid, p_q, p_rarity, p_tag_id, p_untagged, p_wishlisted_by, p_owned_by);
  v_n jsonb;
begin
  if nullif(btrim(p_q), '') is null and p_tag_id is null and not coalesce(p_untagged, false) and p_wishlisted_by is null then
    v_n := (select jsonb_object_agg(snapshot_rarity, n) from (select snapshot_rarity, sum(rows) n from wm.user_rarity_counts
            where user_id = coalesce(p_owned_by, p_uid) and (p_rarity is null or p_rarity = '{}' or snapshot_rarity = any (p_rarity))
            group by 1) x);
  else
    execute format('select jsonb_object_agg(snapshot_rarity, n) from (select uc.snapshot_rarity, count(*) n from public.user_cards uc
                    where %s group by 1) x', v_where) into v_n;
  end if;
  return (select jsonb_build_object('total', sum(n), 'rarities', jsonb_agg(jsonb_build_object('rarity', r, 'key', r, 'name', name,
      'count', n, 'total', n, 'value', n) order by r desc))
    from (select r, name, coalesce((v_n ->> r::text)::int, 0) n
          from unnest(enum_range(null::public.rarity), array['Commune', 'Peu commune', 'Rare', 'Super rare', 'Ultra rare', 'Légendaire']) x (r, name)) y);
end $$;

create or replace function wm.my_collection(p_uid uuid, p_page int default 0, p_limit int default 50, p_sort text default 'rarity',
  p_q text default null, p_rarity public.rarity[] default null, p_tag_id uuid default null, p_untagged boolean default false,
  p_wishlisted_by uuid default null, p_owned_by uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 50);
  -- Ordre stable : clé de tri, puis obtained_at desc, id ; rarity et obtained_at suivent leur index.
  v_order text := case coalesce(p_sort, 'rarity') when 'rarity' then 'uc.snapshot_rarity desc, ' when 'obtained_at' then '' when 'added' then ''
    when 'name' then 'uc.snapshot_title, ' when 'atk' then 'uc.snapshot_atk desc, ' when 'def' then 'uc.snapshot_def desc, '
    when 'starred' then 'uc.starred desc, ' end || 'uc.obtained_at desc, uc.id';
  v_ids uuid[];
begin
  if v_order is null then
    perform wm.raise_err(400, 'invalid_request', 'Tri inconnu');
  end if;
  -- Jointure différée (D§7.3) : les ids de la page par l'index du tri, puis seulement ces lignes, leur carte et leurs étiquettes.
  execute format('select array(select uc.id from public.user_cards uc where %s order by %s limit %s offset %s)',
    wm.collection_filter(p_uid, p_q, p_rarity, p_tag_id, p_untagged, p_wishlisted_by, p_owned_by), v_order, v_limit,
    v_limit * greatest(coalesce(p_page, 0), 0)::bigint)
  into v_ids;
  return jsonb_build_object('collection', (select coalesce(jsonb_agg(jsonb_build_object('id', uc.id, 'user_id', uc.user_id, 'card_id', uc.card_id,
        'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title, 'rarity', c.rarity, 'category', c.category, 'atk', c.atk,
          'def', c.def, 'image_url', c.image_url, 'hide_image', c.hide_image, 'nsfw_image', c.nsfw_image, 'wikipedia_url', c.wikipedia_url,
          'description', c.category, 'summary', c.summary),
        'snapshot_title', uc.snapshot_title, 'snapshot_rarity', uc.snapshot_rarity, 'snapshot_category', uc.snapshot_category,
        'snapshot_atk', uc.snapshot_atk, 'snapshot_def', uc.snapshot_def, 'is_shiny', uc.is_shiny, 'starred', uc.starred, 'count', uc.count,
        -- Étiquettes du lecteur seulement (RLS) : celles d'un autre joueur restent privées.
        'tags', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) order by t.name, t.id)
          from public.user_card_tags ut join public.tags t on t.id = ut.tag_id where ut.user_card_id = uc.id and t.user_id = p_uid), '[]'),
        'obtained_at', uc.obtained_at) order by p.ord), '[]')
      from unnest(v_ids) with ordinality p (id, ord) join public.user_cards uc on uc.id = p.id join public.cards c on c.id = uc.card_id),
    'total', wm.my_collection_stats(p_uid, p_q, p_rarity, p_tag_id, p_untagged, p_wishlisted_by, p_owned_by) -> 'total',
    'pendingTradeCardIds', '[]'::jsonb);
end $$;

-- Collection d'un joueur par pseudo : items réduits (ni étiquettes ni favoris), rarityCounts en cartes uniques sur toute la collection.
create or replace function wm.profile_collection(p_uid uuid, p_username text, p_page int default 0, p_q text default null,
  p_stats boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  r jsonb;
begin
  select * into p from public.profiles where lower(username) = lower(p_username);
  if not found then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  -- shortcut: pas encore d'amis au M1, un profil privé n'est lisible que par lui-même ; brancher l'amitié avec sa table.
  if not p.is_public and p.id is distinct from p_uid then
    perform wm.raise_err(403, 'FORBIDDEN', 'Ce profil est privé');
  end if;
  r := wm.my_collection(p.id, p_page, 50, 'rarity', p_q);
  return jsonb_build_object('collection', (select coalesce(jsonb_agg(jsonb_build_object('id', x -> 'id', 'card', x -> 'card', 'count', x -> 'count',
      'is_shiny', x -> 'is_shiny', 'snapshot_rarity', x -> 'snapshot_rarity') order by o), '[]')
      from jsonb_array_elements(r -> 'collection') with ordinality e (x, o)), 'total', r -> 'total')
    || case when p_stats then jsonb_build_object('rarityCounts', (select jsonb_object_agg(k, (select count(distinct uc.card_id)
         from public.user_cards uc where uc.user_id = p.id and uc.snapshot_rarity = k)) from unnest(enum_range(null::public.rarity)) k))
       else '{}' end;
end $$;

-- Seul écrivain de wikibidous_balance (C5). Défausse : hors grand livre, comptée dans user_stats.discard_wb (p_ref ignoré, l'idempotence est
-- celle de l'appelant). Ailleurs : rejeu de (reason, ref) → solde courant, et l'ouverture vaut solde − discard_wb pour que Σ delta + discard_wb = solde.
create or replace function wm.wallet_apply(p_uid uuid, p_delta int, p_reason text, p_ref text)
returns int language plpgsql security definer set search_path = '' as $$
declare v_bal int;
begin
  -- Verrou d'abord (étape 2 de C4, déjà tenu si l'appelant l'a pris) : solde et discard_wb lus pour l'ouverture ne sont jamais périmés.
  select wikibidous_balance into v_bal from public.profiles where id = p_uid for update;
  if not found then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  if p_reason = 'discard' then
    insert into wm.user_stats as s (user_id, discard_wb) values (p_uid, p_delta)
    on conflict (user_id) do update set discard_wb = s.discard_wb + excluded.discard_wb;
  else
    insert into wm.wb_ledger (user_id, delta, reason, ref, balance_after)
    select p_uid, v_bal - coalesce((select discard_wb from wm.user_stats where user_id = p_uid), 0), 'opening', 'opening', v_bal
    where not exists (select from wm.wb_ledger where user_id = p_uid)
    on conflict do nothing;
    insert into wm.wb_ledger (user_id, delta, reason, ref, balance_after)
    values (p_uid, p_delta, p_reason, p_ref, v_bal + p_delta)
    on conflict do nothing;
    if not found then
      return v_bal;
    end if;
  end if;
  update public.profiles set wikibidous_balance = wikibidous_balance + p_delta
  where id = p_uid and wikibidous_balance + p_delta >= 0
  returning wikibidous_balance into v_bal;
  if not found then  -- l'exception annule aussi les écritures ci-dessus
    perform wm.raise_err(409, 'insufficient_balance', 'Solde insuffisant');
  end if;
  return v_bal;
end $$;

-- 1 à 50 copies uniques, une unité chacune, en une passe ensembliste (D§7.3) ; les ids d'un autre ou inconnus vont dans failed, dans l'ordre reçu.
create or replace function wm.bulk_discard(p_uid uuid, p_ids uuid[], p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_done uuid[];
begin
  if coalesce(cardinality(p_ids), 0) not between 1 and 50 then
    perform wm.raise_err(400, 'invalid_request', 'Entre 1 et 50 cartes par défausse');
  end if;
  if exists (select from unnest(p_ids) x group by x having count(*) > 1) then
    perform wm.raise_err(400, 'invalid_request', 'Cartes en double dans la défausse');
  end if;
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);  -- portée par défaut : la défausse reste permise sans vérification humaine (D§7.0)
  perform wm.lock_user(p_uid);
  -- shortcut: aucun verrou d'échange au M1 ; le 409 « Cette carte est déjà engagée dans un échange en attente » arrive au M4 avec trades.
  v_done := array(select id from public.user_cards where id = any (p_ids) and user_id = p_uid for update);
  -- Suppression d'abord : les lignes restantes ont count > 1 et perdent une unité. L'avatar suit la FK (on delete set null).
  delete from public.user_cards where id = any (v_done) and count = 1;
  update public.user_cards set count = count - 1 where id = any (v_done);
  perform wm.wallet_apply(p_uid, cardinality(v_done), 'discard', 'discard');
  update wm.user_stats set discarded = discarded + cardinality(v_done) where user_id = p_uid;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('discarded_count', cardinality(v_done),
    'failed', (select coalesce(jsonb_agg(jsonb_build_object('id', x, 'reason', 'Vous ne possédez pas cette carte') order by o), '[]')
               from unnest(p_ids) with ordinality u (x, o) where array_position(v_done, x) is null)));
end $$;

-- Défausse en masse d'une seule copie : rien de retiré → 403 (D§7.3 étape 3).
create or replace function wm.discard(p_uid uuid, p_user_card_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  if wm.bulk_discard(p_uid, array[p_user_card_id]) -> 'discarded_count' = '0' then
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('balance', (select wikibidous_balance from public.profiles where id = p_uid)));
end $$;

create or replace function wm.wallet_balance(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_bal int;
begin
  select wikibidous_balance into v_bal from public.profiles where id = p_uid;
  if not found then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  return jsonb_build_object('balance', v_bal);
end $$;

-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4).
-- ledger_balance : Σ delta + discard_wb = solde, pour les joueurs qui ont un grand livre ; rarity_counts : compteurs = group by réel.
create or replace function wm.check_invariants()
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(v), '[]') from (
    select jsonb_build_object('check', 'ledger_balance', 'user_id', p.id, 'balance', p.wikibidous_balance, 'ledger_sum', l.s,
      'discard_wb', coalesce(s.discard_wb, 0)) v
    from public.profiles p
    join (select user_id, sum(delta) s from wm.wb_ledger group by user_id) l on l.user_id = p.id
    left join wm.user_stats s on s.user_id = p.id
    where l.s + coalesce(s.discard_wb, 0) <> p.wikibidous_balance
    union all
    select jsonb_build_object('check', 'negative_balance', 'user_id', p.id)
    from public.profiles p where p.wikibidous_balance < 0
    union all
    select jsonb_build_object('check', 'rarity_counts', 'user_id', user_id, 'snapshot_rarity', snapshot_rarity, 'is_shiny', is_shiny,
      'rows', k.rows, 'copies', k.copies, 'actual_rows', a.n, 'actual_copies', a.c)
    from (select user_id, snapshot_rarity, is_shiny, count(*) n, sum(count) c from public.user_cards group by 1, 2, 3) a
    full join wm.user_rarity_counts k using (user_id, snapshot_rarity, is_shiny)
    where coalesce(a.n, 0) <> coalesce(k.rows, 0) or coalesce(a.c, 0) <> coalesce(k.copies, 0)
  ) x
$$;

-- Un type garde USAGE à PUBLIC par défaut, et le couple revoke/grant ci-dessous ne couvre que schéma, tables et fonctions.
revoke usage on type wm.rarity_delta from public;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
