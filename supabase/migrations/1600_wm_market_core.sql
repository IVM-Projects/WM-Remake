-- ADDITIVE : socle du marché (D§7.5, D§9.4, M3-5…M3-13, M3-26) — config, index, séquestre, file d'alertes, rafales, verrous triés, gardes,
-- notifications, objet Auction, invariants. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

insert into wm.config (key, value, note) values
  ('auction_durations', '[10, 30, 60, 180, 360, 720, 1440]', 'Durées d''enchère permises, en minutes ; 1440 accepté par l''API, jamais proposé par l''UI (conflit n° 1, M3-10)'),
  ('max_concurrent_auctions', '{"free": 5, "pro": 10}', 'Enchères actives par vendeur, échues non réglées comprises ; is_pro ou is_vip → pro (M3-10, M3-14)'),
  ('antisnipe', '{"window_s": 10, "extend_s": 60}', 'Mise à moins de window_s de la fin : end_at repoussé de extend_s, répétable (M3-15)'),
  ('market_bid_burst', '{"count": 10, "window_s": 60}', 'Mises dans la fenêtre avant une nouvelle vérification humaine (M3-13, P3)'),
  ('market_list_burst', '{"count": 5, "window_s": 60}', 'Mises en vente dans la fenêtre avant une nouvelle vérification humaine (M3-13, P3)'),
  ('bid_increment', '{"ratio": 1.1}', 'Mise suivante minimale : max(ceil(mise × ratio), mise + 1), en numeric (M3-10, P6)'),
  ('sales_summary_window', '200', 'Dernières ventes par rareté prises dans la moyenne du marché (M3-19)'),
  ('sales_detail_window', '{"days": 30, "max_rows": 2000}', 'Historique Pro des ventes d''une carte : jours et lignes au plus (M3-19)')
on conflict do nothing;

-- Ici et pas dans 0004 : wm_index.search_text (1300) et pg_trgm (1400) n'existent qu'après (P1). Option A : CONCURRENTLY par le runbook.
create index if not exists auctions_active_end_at_idx on public.auctions (end_at) where status = 'active';
create index if not exists auctions_active_created_at_idx on public.auctions (created_at desc) where status = 'active';
create index if not exists auctions_active_price_idx on public.auctions ((coalesce(current_bid, base_amount))) where status = 'active';
create index if not exists auctions_active_bidder_idx on public.auctions (current_bidder_id) where status = 'active';
-- Expression = wm_index.search_text (1300) : la redéfinir impose un REINDEX de cet index.
create index if not exists auctions_active_search_idx on public.auctions
  using gin (wm_index.search_text(snapshot_search_document, null) extensions.gin_trgm_ops) where status = 'active';
create index if not exists auctions_seller_idx on public.auctions (seller_id, status, created_at desc);
create index if not exists auctions_winner_idx on public.auctions (winner_id, settled_at desc);
create index if not exists auctions_sales_idx on public.auctions (card_id, snapshot_rarity, settled_at desc) where status = 'settled_sold';
create index if not exists auction_bids_auction_idx on public.auction_bids (auction_id, placed_at desc);
create index if not exists auction_bids_bidder_idx on public.auction_bids (bidder_id, placed_at desc);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where not read;

-- Copie en vente (C12, M3-7) : la ligne user_cards telle quelle, hors de user_cards. Aucun id d'ici n'est dans user_cards.
create table if not exists wm.auction_escrow (
  auction_id uuid primary key references public.auctions (id) on delete cascade,
  user_card jsonb not null,
  duration_minutes int not null
);

-- Diffusion wishlist_listed par lots (M3-20) : cursor_user = dernier destinataire servi.
create table if not exists wm.wishlist_alert_queue (
  id bigint generated always as identity primary key,
  auction_id uuid not null references public.auctions (id) on delete cascade,
  cursor_user uuid,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wishlist_alert_queue_pending_idx on wm.wishlist_alert_queue (id) where done_at is null;

-- Rafales du marché (M3-13), sur le modèle de open_window_*.
alter table wm.user_state
  add column if not exists bid_window_start timestamptz,
  add column if not exists bid_window_count int not null default 0,
  add column if not exists list_window_start timestamptz,
  add column if not exists list_window_count int not null default 0;

-- Étapes 2 et 3 de C4 pour plusieurs joueurs (M3-12). `= any` ignore null et doublons ; LockRows passe après le tri, donc verrous dans l'ordre
-- des id. Un id inconnu est ignoré.
create or replace function wm.lock_users(p_uids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform from public.profiles where id = any (p_uids) order by id for update;
  insert into wm.user_state (user_id) select id from public.profiles where id = any (p_uids) order by id on conflict do nothing;
  perform from wm.user_state where user_id = any (p_uids) order by user_id for update;
end $$;

-- Garde des mises (bid) et mises en vente (list), sans écriture (verrou de user_state déjà tenu) : vérification humaine valide, fenêtre
-- de p_kind non pleine, fenêtre des paquets non pleine (R§5.5 : mises, ventes et paquets se verrouillent ensemble, P3).
create or replace function wm.market_guard(p_uid uuid, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := (select value from wm.config where key = 'market_' || p_kind || '_burst');
  o jsonb := (select value from wm.config where key = 'open_burst');
  s wm.user_state;
  v_start timestamptz;
  v_count int;
begin
  if b is null then
    raise exception 'rafale inconnue : %', p_kind using errcode = 'XX000';
  end if;
  select * into s from wm.user_state where user_id = p_uid;
  if p_kind = 'bid' then
    v_start := s.bid_window_start; v_count := s.bid_window_count;
  else
    v_start := s.list_window_start; v_count := s.list_window_count;
  end if;
  if s.human_verified_until is null or s.human_verified_until <= now()
     or (v_start > now() - make_interval(secs => (b ->> 'window_s')::int) and v_count >= (b ->> 'count')::int)
     or (s.open_window_start > now() - make_interval(secs => (o ->> 'window_s')::int) and s.open_window_count >= (o ->> 'count')::int) then
    perform wm.raise_err(403, 'human_verification_required', 'Vérification anti-bot requise pour continuer.',
      '{"human_verification_required": true}');
  end if;
end $$;

-- Après le succès (une exception annulerait l'écriture, P3) : compteur de fenêtre comme open_pack ; le plafond atteint retire la vérification.
create or replace function wm.market_tick(p_uid uuid, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := (select value from wm.config where key = 'market_' || p_kind || '_burst');
  v_win interval := make_interval(secs => (b ->> 'window_s')::int);
  v_n int;
begin
  if p_kind = 'bid' then
    update wm.user_state set bid_window_count = case when bid_window_start > now() - v_win then bid_window_count + 1 else 1 end,
      bid_window_start = case when bid_window_start > now() - v_win then bid_window_start else now() end
    where user_id = p_uid
    returning bid_window_count into v_n;
  else
    update wm.user_state set list_window_count = case when list_window_start > now() - v_win then list_window_count + 1 else 1 end,
      list_window_start = case when list_window_start > now() - v_win then list_window_start else now() end
    where user_id = p_uid
    returning list_window_count into v_n;
  end if;
  if v_n >= (b ->> 'count')::int then
    update wm.user_state set human_verified_until = null where user_id = p_uid;
  end if;
end $$;

-- Turnstile validé par le serveur (D§7.1) : les rafales d'ouvertures, de mises et de mises en vente repartent de zéro (M3-13).
create or replace function wm.set_human_verified(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform wm.actor(p_uid);
  perform wm.lock_user(p_uid);
  update wm.user_state
  set human_verified_until = now() + make_interval(hours => (select value::int from wm.config where key = 'human_check_ttl_h')),
      open_window_count = 0, bid_window_count = 0, bid_window_start = null, list_window_count = 0, list_window_start = null
  where user_id = p_uid;
  return '{"ok": true}';
end $$;

-- Entrée au séquestre (M3-7) de la copie déjà verrouillée par l'appelant. Pile héritée (count > 1) : une unité part sous un id neuf.
-- La suppression emporte étiquettes (cascade) et avatar (set null) ; les compteurs par rareté suivent par trigger.
create or replace function wm.escrow_put(p_auction_id uuid, p_copy public.user_cards, p_duration int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_copy.count = 1 then
    delete from public.user_cards where id = p_copy.id;
  else
    update public.user_cards set count = count - 1 where id = p_copy.id;
  end if;
  if not found then  -- copie disparue : sans ce garde, le séquestre créerait une carte
    raise exception 'copie absente : %', p_copy.id using errcode = 'XX000';
  end if;
  insert into wm.auction_escrow (auction_id, user_card, duration_minutes)
  values (p_auction_id, to_jsonb(p_copy) || case when p_copy.count = 1 then '{}'
    else jsonb_build_object('id', gen_random_uuid(), 'count', 1) end, p_duration);
end $$;

-- Sortie du séquestre (M3-7) : toujours une nouvelle ligne, count 1, pas favorite, sans étiquettes ; obtained_at d'origine sauf p_obtained_at.
create or replace function wm.escrow_release(p_auction_id uuid, p_to uuid, p_obtained_at timestamptz default null)
returns public.user_cards language plpgsql security definer set search_path = '' as $$
declare u public.user_cards;
begin
  -- Fonction dans le from : (f(…)).* l'appellerait une fois par colonne.
  insert into public.user_cards
  select r.* from wm.auction_escrow e, jsonb_populate_record(null::public.user_cards, e.user_card
    || jsonb_build_object('id', gen_random_uuid(), 'starred', false, 'count', 1, 'user_id', p_to)
    || jsonb_strip_nulls(jsonb_build_object('obtained_at', p_obtained_at))) r
  where e.auction_id = p_auction_id
  returning * into u;
  if not found then  -- erreur interne, pas un refus métier : jamais P0001
    raise exception 'séquestre absent pour %', p_auction_id using errcode = 'XX000';
  end if;
  delete from wm.auction_escrow where auction_id = p_auction_id;
  return u;
end $$;

-- data des notifications (M3-8), en snake_case. Lit le séquestre : à appeler avant escrow_release.
create or replace function wm.notification_data(p_type text, p_auction_id uuid, p_amount int default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('auction_id', a.id, 'card_id', a.card_id, 'card_title', e.user_card ->> 'snapshot_title',
      'wikipedia_title', c.wikipedia_title)
    || jsonb_strip_nulls(jsonb_build_object('amount', p_amount))
    || case when p_type = 'wishlist_listed' then jsonb_build_object('end_at', a.end_at) else '{}' end
  from public.auctions a join public.cards c on c.id = a.card_id join wm.auction_escrow e on e.auction_id = a.id
  where a.id = p_auction_id
$$;

-- Une instruction triée par user_id (P28) : les FOR KEY SHARE de la clé étrangère sur profiles suivent l'ordre C4.
create or replace function wm.notify_auction(p_users uuid[], p_type text, p_auction_id uuid, p_amount int default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_data jsonb := wm.notification_data(p_type, p_auction_id, p_amount);
  n int;
begin
  insert into public.notifications (user_id, type, data)
  select u, p_type, v_data from unnest(p_users) u where u is not null order by u;
  get diagnostics n = row_count;
  return n;
end $$;

-- Mise minimale suivante (P5, P6) ; null hors active.
create or replace function wm.min_next_bid(a public.auctions)
returns int language sql stable security definer set search_path = '' as $$
  select case when a.status <> 'active' then null when a.current_bid is null then a.base_amount
    else greatest(ceil(a.current_bid * (value ->> 'ratio')::numeric)::int, a.current_bid + 1) end
  from wm.config where key = 'bid_increment'
$$;

-- Seul constructeur de l'objet Auction (P5) : colonnes + champs calculés (M3-6). owned est un overlay par joueur, posé ailleurs.
create or replace function wm.auction_json(a public.auctions)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(a) || jsonb_build_object(
    'seller', (select jsonb_build_object('id', p.id, 'username', p.username) from public.profiles p where p.id = a.seller_id),
    'current_bidder', (select jsonb_build_object('username', p.username) from public.profiles p where p.id = a.current_bidder_id),
    'card', (select jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title, 'wikipedia_url', c.wikipedia_url, 'rarity', c.rarity,
        'category', c.category, 'image_url', c.image_url, 'hide_image', c.hide_image, 'nsfw_image', c.nsfw_image, 'atk', c.atk, 'def', c.def,
        'q_score', c.q_score, 'pageviews', c.pageviews)
      from public.cards c where c.id = a.card_id),
    'effective_bid', coalesce(a.current_bid, a.base_amount),
    'bid_count', a.bids_count,
    'buyer_id', a.winner_id,
    'min_next_bid', wm.min_next_bid(a))
$$;

-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4).
-- ledger_balance : Σ delta + discard_wb = solde, pour les joueurs qui ont un grand livre ; rarity_counts : compteurs = group by réel.
-- Marché (M3-26) : market_money (argent des mises conservé), reservation (une mise débitée non remboursée = current_bid), escrow.
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
    select jsonb_build_object('check', 'market_money', 'ledger', l.s, 'held', h.s)
    from (select coalesce(sum(delta), 0) s from wm.wb_ledger where reason in ('bid', 'refund', 'settle')) l,
      (select coalesce(sum(current_bid), 0) s from public.auctions where status = 'active' and current_bidder_id is not null) h
    where l.s + h.s <> 0
    union all
    select jsonb_build_object('check', 'reservation', 'auction_id', a.id, 'current_bid', a.current_bid, 'unrefunded', r.amounts)
    from public.auctions a
    cross join lateral (select coalesce(jsonb_agg(b.amount order by b.amount), '[]') amounts from public.auction_bids b
      where b.auction_id = a.id
        and exists (select from wm.wb_ledger l where l.reason = 'bid' and l.ref = 'bid:' || b.id)
        and not exists (select from wm.wb_ledger l where l.reason = 'refund' and l.ref = 'refund:' || b.id)) r
    where a.status = 'active' and a.current_bidder_id is not null and r.amounts <> jsonb_build_array(a.current_bid)
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', a.id, 'problem', 'missing')
    from public.auctions a where a.status = 'active' and not exists (select from wm.auction_escrow e where e.auction_id = a.id)
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', a.id, 'problem', 'orphan')
    from wm.auction_escrow e join public.auctions a on a.id = e.auction_id where a.status <> 'active'
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', e.auction_id, 'problem', 'owned')
    from wm.auction_escrow e where exists (select from public.user_cards uc where uc.id = (e.user_card ->> 'id')::uuid)
  ) x
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
