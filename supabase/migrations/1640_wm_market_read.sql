-- ADDITIVE : lectures du marché (D§7.5, D§9.5, M3-19, P5, P11, P17, P24, P26) — liste partagée et overlay, onglets du joueur, détail avec
-- règlement paresseux, ventes en résumé et détail Pro. Idempotente. Seule écriture : le règlement du détail, par wm.settle_auction.

-- Partagée, sans joueur : enchères active seulement, pages de 1 à 50 lignes à partir de 1 (P17, P24). Clause en littéraux comme
-- wm.cards_list (1520) : le plan ne garde que les filtres posés.
create or replace function wm.market_list(p_page int default 1, p_limit int default 50, p_sort text default 'recent', p_q text default null,
  p_rarity public.rarity[] default null, p_card_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_page int := coalesce(p_page, 1);
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_q text := nullif(btrim(p_q), '');
  -- Clés des index partiels de 1600 (création, fin, prix effectif), puis id : ordre stable d'une page à l'autre.
  v_order text := case coalesce(p_sort, 'recent') when 'recent' then 'created_at desc, id' when 'ending_soon' then 'end_at, id'
    when 'price_asc' then 'coalesce(current_bid, base_amount), id' when 'price_desc' then 'coalesce(current_bid, base_amount) desc, id' end;
  v_where text;
  v_ids uuid[];
  v_n bigint;
begin
  if v_page < 1 then
    perform wm.raise_err(400, 'invalid_request', 'La page commence à 1');
  end if;
  if v_order is null then
    perform wm.raise_err(400, 'invalid_request', 'Tri inconnu');
  end if;
  if char_length(v_q) < 2 then
    perform wm.raise_err(400, 'invalid_request', 'La recherche demande au moins 2 caractères');
  end if;
  v_where := concat_ws(' and ', 'status = ''active''',
    -- Ni lettre ni chiffre : 'false' coupe le plan sans lecture. Sinon %q%, même à 2 caractères (aucun index de préfixe ici, et peu d'enchères
    -- actives), jokers LIKE pris à la lettre, sur l'expression exacte de auctions_active_search_idx.
    case when v_q !~ '[[:alnum:]]' then 'false'
         when v_q is not null then format('wm_index.search_text(snapshot_search_document, null) like %L', '%' || replace(replace(replace(
           extensions.unaccent('extensions.unaccent', lower(v_q)), '\', '\\'), '%', '\%'), '_', '\_') || '%') end,
    case when p_rarity <> '{}' then format('snapshot_rarity = any (%L)', p_rarity) end,
    case when p_card_id is not null then format('card_id = %L', p_card_id) end);
  -- Jointure différée (1300) : les ids de la page par l'index du tri, puis l'objet Auction de ces lignes seulement.
  execute format('select array(select id from public.auctions where %s order by %s limit %s offset %s)', v_where, v_order, v_limit,
    (v_page - 1)::bigint * v_limit) into v_ids;
  execute format('select count(*) from public.auctions where %s', v_where) into v_n;
  return jsonb_build_object('auctions', (select coalesce(jsonb_agg(wm.auction_json(a) order by p.o), '[]')
      from unnest(v_ids) with ordinality p (id, o) join public.auctions a on a.id = p.id),
    'hasMore', v_page::bigint * v_limit < v_n, 'total', v_n);
end $$;

-- Overlay par joueur de la liste et du détail partagés (M3-19) : les cartes possédées parmi p_card_ids, dans leur ordre.
create or replace function wm.market_overlay(p_uid uuid, p_card_ids uuid[])
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('ownedCardIds', (select coalesce(jsonb_agg(p.id order by p.o), '[]') from unnest(p_card_ids) with ordinality p (id, o)
    where exists (select from public.user_cards uc where uc.card_id = p.id and uc.user_id = p_uid)))
$$;

-- GET /mine (R§3.5, union des formes) : ventes active du joueur, échues non réglées comprises (M3-14), et son plafond (M3-10).
create or replace function wm.market_mine(p_uid uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('sellingCount', count(*),
    'maxConcurrentAuctions', (select (c.value ->> case when p.is_pro or p.is_vip then 'pro' else 'free' end)::int
      from wm.config c, public.profiles p where c.key = 'max_concurrent_auctions' and p.id = p_uid),
    'auctions', coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'card_id', a.card_id, 'user_card_id', a.user_card_id)
      order by a.created_at desc, a.id), '[]'))
  from public.auctions a where a.seller_id = p_uid and a.status = 'active'
$$;

-- ?mine=1, non caché : selling entier (au plus le plafond) ; bidding, won et history par pages de 50 à partir de 1. owned posé ici (P11).
create or replace function wm.market_mine_lists(p_uid uuid, p_page int default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_page bigint := coalesce(p_page, 1);  -- bigint : page × 50 sans dépassement
  v_off bigint := (v_page - 1) * 50;
  v_mine jsonb := wm.market_mine(p_uid) - 'auctions';
  v_counts jsonb;
begin
  if v_page < 1 then
    perform wm.raise_err(400, 'invalid_request', 'La page commence à 1');
  end if;
  v_counts := jsonb_build_object('selling', v_mine -> 'sellingCount',
    'bidding', (select count(distinct auction_id) from public.auction_bids where bidder_id = p_uid),
    'won', (select count(*) from public.auctions where winner_id = p_uid and status = 'settled_sold'),
    'history', (select count(*) from public.auctions where seller_id = p_uid and status <> 'active'));
  return v_mine || jsonb_build_object('mine', true, 'counts', v_counts,
    'wonHasMore', v_page * 50 < (v_counts ->> 'won')::bigint, 'historyHasMore', v_page * 50 < (v_counts ->> 'history')::bigint,
    'selling', (select coalesce(jsonb_agg(wm.auction_json(a) || jsonb_build_object('owned',
        exists (select from public.user_cards uc where uc.user_id = p_uid and uc.card_id = a.card_id)) order by a.created_at desc, a.id), '[]')
      from public.auctions a where a.seller_id = p_uid and a.status = 'active'),
    -- Par dernière mise du joueur ; my_last_bid = le montant de cette mise.
    'bidding', (select coalesce(jsonb_agg(wm.auction_json(a) || jsonb_build_object('owned',
        exists (select from public.user_cards uc where uc.user_id = p_uid and uc.card_id = a.card_id), 'my_last_bid', g.amount,
        'my_state', case when a.status = 'active' then case when a.current_bidder_id = p_uid then 'leading' else 'outbid' end
                         when a.winner_id = p_uid then 'won' else 'lost' end) order by g.last_at desc, g.auction_id), '[]')
      from (select auction_id, max(placed_at) last_at, (array_agg(amount order by placed_at desc))[1] amount from public.auction_bids
            where bidder_id = p_uid group by auction_id order by last_at desc, auction_id limit 50 offset v_off) g
      join public.auctions a on a.id = g.auction_id),
    'won', (select coalesce(jsonb_agg(wm.auction_json(a) || jsonb_build_object('owned',
        exists (select from public.user_cards uc where uc.user_id = p_uid and uc.card_id = a.card_id)) order by a.settled_at desc, a.id), '[]')
      from public.auctions a where a.id in (select id from public.auctions where winner_id = p_uid and status = 'settled_sold'
        order by settled_at desc, id limit 50 offset v_off)),
    -- Retirée sans settled_at : rangée à sa création (P26).
    'history', (select coalesce(jsonb_agg(wm.auction_json(a) || jsonb_build_object('owned',
        exists (select from public.user_cards uc where uc.user_id = p_uid and uc.card_id = a.card_id))
        order by coalesce(a.settled_at, a.created_at) desc, a.id), '[]')
      from public.auctions a where a.id in (select id from public.auctions where seller_id = p_uid and status <> 'active'
        order by coalesce(settled_at, created_at) desc, id limit 50 offset v_off)));
end $$;

-- Détail partagé : une enchère échue encore active est réglée d'abord, puis relue (règlement paresseux, M3-18). volatile : PostgREST exécute
-- une fonction stable en lecture seule, et le règlement écrit. Retirée → 404 comme inconnue (M3-16).
create or replace function wm.auction_detail(p_auction_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare a public.auctions;
begin
  select * into a from public.auctions where id = p_auction_id;
  if found and a.status = 'active' and a.end_at <= clock_timestamp() then
    perform wm.settle_auction(a.id);
    select * into a from public.auctions where id = a.id;
  end if;
  if a.id is null or a.status = 'cancelled' then
    perform wm.raise_err(404, null, 'Enchère introuvable');
  end if;
  return jsonb_build_object('auction', wm.auction_json(a), 'bids', (select coalesce(jsonb_agg(jsonb_build_object('amount', b.amount,
      'placed_at', b.placed_at, 'created_at', b.placed_at, 'bidder', jsonb_build_object('username', p.username)) order by b.placed_at desc, b.id), '[]')
    from (select * from public.auction_bids where auction_id = a.id order by placed_at desc, id limit 50) b
    join public.profiles p on p.id = b.bidder_id));
end $$;

-- Partagé : moyenne arrondie et nombre des sales_summary_window dernières ventes de la carte, par rareté figée ; une rareté sans vente est
-- absente. Une sous-requête par rareté suit auctions_sales_idx.
create or replace function wm.card_sales_summary(p_card_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int := (select value::int from wm.config where key = 'sales_summary_window');
begin
  if not exists (select from public.cards where id = p_card_id) then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  return jsonb_build_object('summary', (select coalesce(jsonb_object_agg(r, jsonb_build_object('average', round(s.average)::int, 'count', s.n)), '{}')
    from unnest(enum_range(null::public.rarity)) r
    cross join lateral (select avg(final_price) average, count(*) n from (select final_price from public.auctions
      where card_id = p_card_id and snapshot_rarity = r and status = 'settled_sold' order by settled_at desc limit v_n) x) s
    where s.n > 0));
end $$;

-- Détail Pro (is_pro ou is_vip), vérifié avant la carte : ventes de sales_detail_window (jours, lignes au plus), plus récente d'abord ;
-- recent = les 20 premières.
create or replace function wm.card_sales(p_uid uuid, p_card_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_w jsonb := (select value from wm.config where key = 'sales_detail_window');
  v jsonb;
begin
  if not coalesce((select is_pro or is_vip from public.profiles where id = p_uid), false) then
    perform wm.raise_err(403, 'pro_required', 'Fonction réservée aux membres Pro');
  end if;
  if not exists (select from public.cards where id = p_card_id) then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  v := (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'rarity', snapshot_rarity, 'is_shiny', is_shiny, 'final_price', final_price,
      'settled_at', settled_at) order by settled_at desc, id), '[]')
    from (select * from public.auctions where card_id = p_card_id and status = 'settled_sold'
          and settled_at > now() - make_interval(days => (v_w ->> 'days')::int)
          order by settled_at desc, id limit (v_w ->> 'max_rows')::int) s);
  return jsonb_build_object('sales', v, 'recent', jsonb_path_query_array(v, '$[0 to 19]'));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
