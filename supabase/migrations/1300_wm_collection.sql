-- ADDITIVE : collection, lectures (D§7.3, D§9.3, D§9.4, R§3.3) — compteurs par rareté, index, pages stables, stats, collection d'un profil. Idempotente.

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
-- lock_timeout : échouer plutôt que bloquer toutes les écritures en file derrière le verrou.
do $$ begin
  set local lock_timeout = '5s';
  lock table public.user_cards in share mode;
  truncate wm.user_rarity_counts;
  insert into wm.user_rarity_counts (user_id, snapshot_rarity, is_shiny, rows, copies)
  select user_id, snapshot_rarity, is_shiny, count(*), sum(count) from public.user_cards group by 1, 2, 3;
end $$;

-- Titre + catégorie sans accents ni casse. immutable (unaccent n'est que stable) pour l'index trigramme du catalogue (Task 8).
create or replace function wm.search_text(t text, c text)
returns text language sql immutable parallel safe security definer set search_path = '' as $$
  select extensions.unaccent('extensions.unaccent', lower(t || ' ' || coalesce(c, '')))
$$;

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
    case when v_q is not null then format('strpos(wm.search_text(uc.snapshot_title, uc.snapshot_category), %L) > 0', v_q) end,
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

-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4). rarity_counts : compteurs = group by réel.
create or replace function wm.check_invariants()
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(v), '[]') from (
    select jsonb_build_object('check', 'ledger_balance', 'user_id', p.id, 'balance', p.wikibidous_balance, 'ledger_sum', l.s) v
    from public.profiles p
    join (select user_id, sum(delta) s from wm.wb_ledger group by user_id) l on l.user_id = p.id
    where l.s <> p.wikibidous_balance
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

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
