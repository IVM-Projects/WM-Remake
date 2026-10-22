-- ADDITIVE : socle des échanges (D§7.6, D§9.4, M4-2, M4-10, P3, P7, P8, P9) — config, index, verrou d'échange au niveau card_id dans la vente
-- et la défausse, pendingTradeCardIds, objet Trade, notifications, invariant trade_money. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

insert into wm.config (key, value, note) values
  ('trade_limits', '{"cards": 100, "wb": 10000, "expiry_h": 168}', 'Par côté : cartes et wikibidous au plus ; expiration en heures (D§7.6, prob. ; 48 h vient du clone)'),
  ('friend_limit', 'null'::jsonb, 'Désactivée : valeur inconnue (R§10.5, C30, M4-11)'),
  ('list_caps', '{"trades_closed": 200, "notifications": 50, "friend_search": 20}', 'Plafonds des listes sans pagination (D§7.6, D§7.9, M4-16)')
on conflict do nothing;

-- Index de performance (D:810) ; option A : CONCURRENTLY par le runbook.
create index if not exists trades_initiator_idx on public.trades (initiator_id, status, created_at desc);
create index if not exists trades_recipient_idx on public.trades (recipient_id, status, created_at desc);
create index if not exists trades_pending_expiry_idx on public.trades (expires_at) where status = 'pending';
create index if not exists trades_parent_idx on public.trades (parent_trade_id) where parent_trade_id is not null;
create index if not exists trade_items_trade_idx on public.trade_items (trade_id);
create index if not exists trade_items_offered_idx on public.trade_items (offered_by, card_id);
create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);

-- Verrou d'échange (M4-2) : p_uid offre p_card_id dans un échange en attente (P3 : pending et non échu). Lu sans verrou, sous celui du profil.
create or replace function wm.card_locked(p_uid uuid, p_card_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select from public.trade_items i join public.trades t on t.id = i.trade_id
    where i.offered_by = p_uid and i.card_id = p_card_id and t.status = 'pending' and t.expires_at > clock_timestamp())
$$;

-- pendingTradeCardIds (C13) : card_id et user_card_id de mes éléments en attente, en texte, triés et sans doublon.
create or replace function wm.pending_trade_card_ids(p_uid uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x), '[]') from (
    select distinct x from public.trade_items i join public.trades t on t.id = i.trade_id,
      unnest(array[i.card_id::text, i.user_card_id::text]) x
    where i.offered_by = p_uid and t.status = 'pending' and t.expires_at > clock_timestamp()) s
$$;

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
    -- Les échanges d'un autre joueur ne regardent pas le lecteur.
    'pendingTradeCardIds', case when coalesce(p_owned_by, p_uid) = p_uid then wm.pending_trade_card_ids(p_uid) else '[]'::jsonb end);
end $$;

-- Seul constructeur de l'objet Trade (P7). Une ligne pending échue, que le cron n'a pas encore passée, se lit expired (P3).
create or replace function wm.trade_json(t public.trades)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(t) || jsonb_build_object(
    'status', case when t.status = 'pending' and t.expires_at <= clock_timestamp() then 'expired' else t.status::text end,
    'initiator', (select jsonb_build_object('id', p.id, 'username', p.username) from public.profiles p where p.id = t.initiator_id),
    'recipient', (select jsonb_build_object('id', p.id, 'username', p.username) from public.profiles p where p.id = t.recipient_id),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('offered_by', i.offered_by, 'card_id', i.card_id, 'user_card_id', i.user_card_id,
          'snapshot_rarity', i.snapshot_rarity, 'is_shiny', i.is_shiny,
          'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title, 'image_url', c.image_url, 'rarity', c.rarity))
        order by i.offered_by <> t.initiator_id, i.snapshot_rarity desc, c.wikipedia_title, i.id), '[]')
      from public.trade_items i join public.cards c on c.id = i.card_id where i.trade_id = t.id),
    'counter_trade_id', (select k.id from public.trades k where k.parent_trade_id = t.id order by k.created_at desc, k.id desc limit 1))
$$;

-- data des notifications d'échange (M4-12) : l'auteur de l'action, sans texte. Une instruction triée par user_id (P28).
create or replace function wm.notify_trade(p_users uuid[], p_type text, p_trade_id uuid, p_actor uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_data jsonb := jsonb_build_object('trade_id', p_trade_id, 'user_id', p_actor,
    'username', (select username from public.profiles where id = p_actor));
  n int;
begin
  insert into public.notifications (user_id, type, data)
  select u, p_type, v_data from unnest(p_users) u where u is not null order by u;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function wm.create_auction(p_uid uuid, p_card_id uuid, p_base_amount int, p_duration_minutes int, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_actor jsonb;
  v_max int;
  k public.user_cards;
  a public.auctions;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  v_actor := wm.actor(p_uid);
  if not coalesce((select value @> to_jsonb(p_duration_minutes) from wm.config where key = 'auction_durations'), false) then
    perform wm.raise_err(400, 'invalid_request', 'Durée d''enchère invalide');
  end if;
  if coalesce(p_base_amount, 0) < 1 then
    perform wm.raise_err(400, 'invalid_request', 'La mise de départ doit être d''au moins 1 wikibidou');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_users(array[p_uid]);
  perform wm.market_guard(p_uid, 'list');
  select * into k from public.user_cards where id = p_card_id and user_id = p_uid for update;
  if not found then  -- id catalogue : la plus ancienne copie du vendeur
    select * into k from public.user_cards where card_id = p_card_id and user_id = p_uid order by obtained_at, id limit 1 for update;
  end if;
  if not found then
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  -- Verrou d'échange au niveau card_id (M4-2, M4-10) : aucune copie d'une carte promise ne part en vente.
  if wm.card_locked(p_uid, k.card_id) then
    perform wm.raise_err(409, null, 'Cette carte est déjà engagée dans un échange en attente');
  end if;
  v_max := (select (value ->> case when (v_actor ->> 'is_pro')::boolean or (v_actor ->> 'is_vip')::boolean then 'pro' else 'free' end)::int
            from wm.config where key = 'max_concurrent_auctions');
  -- Échues non réglées comprises : elles sont encore active (M3-14).
  if (select count(*) from public.auctions where seller_id = p_uid and status = 'active') >= v_max then
    perform wm.raise_err(409, null, format('Limite de %s enchères actives atteinte', v_max));
  end if;
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, snapshot_atk, snapshot_def, snapshot_search_document,
    is_shiny, base_amount, listing_base_amount, end_at)
  select p_uid, k.card_id, k.id, k.snapshot_rarity, k.snapshot_atk, k.snapshot_def,
    concat_ws(' ', k.snapshot_title, k.snapshot_category, left(c.summary, 300)), k.is_shiny, p_base_amount, p_base_amount,
    clock_timestamp() + make_interval(mins => p_duration_minutes)
  from public.cards c where c.id = k.card_id
  returning * into a;
  perform wm.escrow_put(a.id, k, p_duration_minutes);
  insert into wm.wishlist_alert_queue (auction_id) values (a.id);
  perform wm.market_tick(p_uid, 'list');
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('auction_id', a.id, 'id', a.id, 'end_at', a.end_at));
end $$;

-- 1 à 50 copies uniques, une unité chacune, en une passe ensembliste (D§7.3) ; dans failed, dans l'ordre reçu : mes copies d'une carte promise
-- dans un échange en attente (M4-10), puis les ids d'un autre ou inconnus.
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
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  v_done := array(select id from public.user_cards where id = any (p_ids) and user_id = p_uid and not wm.card_locked(p_uid, card_id)
                  order by id for update);
  -- Suppression d'abord : les lignes restantes ont count > 1 et perdent une unité. L'avatar suit la FK (on delete set null).
  delete from public.user_cards where id = any (v_done) and count = 1;
  update public.user_cards set count = count - 1 where id = any (v_done);
  perform wm.wallet_apply(p_uid, cardinality(v_done), 'discard', 'discard');
  update wm.user_stats set discarded = discarded + cardinality(v_done) where user_id = p_uid;
  -- Hors de v_done, une copie encore à moi ne peut être que verrouillée : le profil tenu, rien d'autre ne l'a déplacée.
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('discarded_count', cardinality(v_done),
    'failed', (select coalesce(jsonb_agg(jsonb_build_object('id', x, 'reason',
        case when exists (select from public.user_cards where id = x and user_id = p_uid)
          then 'Cette carte est déjà engagée dans un échange en attente' else 'Vous ne possédez pas cette carte' end) order by o), '[]')
               from unnest(p_ids) with ordinality u (x, o) where array_position(v_done, x) is null)));
end $$;

-- Défausse d'une seule copie : rien de retiré → 409 du verrou d'échange (M4-10), sinon 403 (D§7.3 étape 3).
create or replace function wm.discard(p_uid uuid, p_user_card_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_r jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  v_r := wm.bulk_discard(p_uid, array[p_user_card_id]);
  if v_r -> 'discarded_count' = '0' then
    if v_r #>> '{failed,0,reason}' = 'Cette carte est déjà engagée dans un échange en attente' then
      perform wm.raise_err(409, null, v_r #>> '{failed,0,reason}');
    end if;
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('balance', (select wikibidous_balance from public.profiles where id = p_uid)));
end $$;

-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4).
-- ledger_balance : Σ delta + discard_wb = solde, pour les joueurs qui ont un grand livre ; rarity_counts : compteurs = group by réel.
-- Marché (M3-26) : market_money (argent des mises conservé), reservation (une mise débitée non remboursée = current_bid), escrow.
-- Échanges (P8) : trade_money (Σ delta nulle par référence trade:<id>).
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
    union all
    -- shortcut: somme globale ; le grand livre cascade par joueur (1000_wm_core.sql:39), donc supprimer un seul côté d'une vente réglée
    -- la rend non nulle. À revoir avec la suppression de compte (M6).
    select jsonb_build_object('check', 'market_money', 'ledger', l.s, 'held', h.s)
    from (select coalesce(sum(delta), 0) s from wm.wb_ledger where reason in ('bid', 'refund', 'settle')) l,
      (select coalesce(sum(current_bid), 0) s from public.auctions where status = 'active' and current_bidder_id is not null) h
    where l.s + h.s <> 0
    union all
    -- Réservations d'après le grand livre : débit bid:<id> du miseur sans refund:<id>, montant = −delta. Une seule, du meneur, = current_bid.
    select jsonb_build_object('check', 'reservation', 'auction_id', a.id, 'current_bid', a.current_bid, 'unrefunded', r.amounts)
    from public.auctions a
    cross join lateral (select coalesce(jsonb_agg(-l.delta order by -l.delta), '[]') amounts, count(*) n, min(-l.delta) amount,
        bool_and(b.bidder_id = a.current_bidder_id) leader
      from public.auction_bids b
      join wm.wb_ledger l on l.reason = 'bid' and l.ref = 'bid:' || b.id and l.user_id = b.bidder_id
      where b.auction_id = a.id
        and not exists (select from wm.wb_ledger f where f.reason = 'refund' and f.ref = 'refund:' || b.id and f.user_id = b.bidder_id)) r
    where a.status = 'active' and a.current_bidder_id is not null
      and not coalesce(r.n = 1 and r.amount = a.current_bid and r.leader, false)
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', a.id, 'problem', 'missing')
    from public.auctions a where a.status = 'active' and not exists (select from wm.auction_escrow e where e.auction_id = a.id)
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', a.id, 'problem', 'orphan')
    from wm.auction_escrow e join public.auctions a on a.id = e.auction_id where a.status <> 'active'
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', e.auction_id, 'problem', 'owned')
    from wm.auction_escrow e where exists (select from public.user_cards uc where uc.id = (e.user_card ->> 'id')::uuid)
    union all
    -- shortcut: même limite que market_money : le grand livre cascade par joueur, supprimer un seul des deux joueurs déséquilibre la
    -- référence. À revoir avec la suppression de compte (M6).
    select jsonb_build_object('check', 'trade_money', 'ref', ref, 'sum', sum(delta))
    from wm.wb_ledger where reason = 'trade' group by ref having sum(delta) <> 0
  ) x
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
