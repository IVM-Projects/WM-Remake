-- Marché (1600_wm_market_core.sql, puis 1610…1650) : config, index, séquestre, verrous, gardes anti-bot, notifications, objet Auction, invariants.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ses cartes, et ne filtre que sur ses enchères.

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

-- Carte du catalogue au titre unique.
create function pg_temp.card(p_title text, p_rarity public.rarity default 'R', p_summary text default null) returns uuid language sql as $$
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, 1200, 800, 'Catégorie marché', p_summary)
  returning id
$$;

-- Joueur vérifié (fenêtres anti-bot remises à zéro), solde et Pro au choix.
create function pg_temp.player(p_name text, p_balance int default 0, p_pro boolean default false) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  update public.profiles set is_pro = p_pro where id = u;
  return u;
end $$;

-- Config du marché (M3-10), chaque clé avec sa note.
do $$ begin
  assert (select jsonb_object_agg(key, value) from wm.config where key in ('auction_durations', 'max_concurrent_auctions', 'antisnipe',
    'market_bid_burst', 'market_list_burst', 'bid_increment', 'sales_summary_window', 'sales_detail_window'))
    = '{"auction_durations":[10,30,60,180,360,720,1440],"max_concurrent_auctions":{"free":5,"pro":10},"antisnipe":{"window_s":10,"extend_s":60},
    "market_bid_burst":{"count":10,"window_s":60},"market_list_burst":{"count":5,"window_s":60},"bid_increment":{"ratio":1.1},
    "sales_summary_window":200,"sales_detail_window":{"days":30,"max_rows":2000}}'::jsonb, 'config du marché';
  assert not exists (select from wm.config where key in ('auction_durations', 'max_concurrent_auctions', 'antisnipe', 'market_bid_burst',
    'market_list_burst', 'bid_increment', 'sales_summary_window', 'sales_detail_window') and coalesce(note, '') = ''), 'note manquante';
end $$;

-- Index du D§9.4 (P1) et de la file d'alertes.
do $$ declare bad text; begin
  select string_agg(v.n, ', ') into bad from (values
    ('auctions_active_end_at_idx', 'public.auctions USING btree (end_at) WHERE (status = ''active'''),
    ('auctions_active_created_at_idx', 'public.auctions USING btree (created_at DESC) WHERE (status = ''active'''),
    ('auctions_active_price_idx', 'public.auctions USING btree (COALESCE(current_bid, base_amount)) WHERE (status = ''active'''),
    ('auctions_active_bidder_idx', 'public.auctions USING btree (current_bidder_id) WHERE (status = ''active'''),
    ('auctions_active_search_idx',
     'public.auctions USING gin (wm_index.search_text(snapshot_search_document, NULL::text) extensions.gin_trgm_ops) WHERE (status = ''active'''),
    ('auctions_seller_idx', 'public.auctions USING btree (seller_id, status, created_at DESC)'),
    ('auctions_winner_idx', 'public.auctions USING btree (winner_id, settled_at DESC)'),
    ('auctions_sales_idx', 'public.auctions USING btree (card_id, snapshot_rarity, settled_at DESC) WHERE (status = ''settled_sold'''),
    ('auction_bids_auction_idx', 'public.auction_bids USING btree (auction_id, placed_at DESC)'),
    ('auction_bids_bidder_idx', 'public.auction_bids USING btree (bidder_id, placed_at DESC)'),
    ('notifications_user_idx', 'public.notifications USING btree (user_id, created_at DESC)'),
    ('notifications_unread_idx', 'public.notifications USING btree (user_id) WHERE (NOT read)'),
    ('wishlist_alert_queue_pending_idx', 'wm.wishlist_alert_queue USING btree (id) WHERE (done_at IS NULL)')) v (n, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef like '% ON ' || v.def || '%');
  assert bad is null, 'index absents ou différents : ' || bad;
end $$;

-- lock_users : doublons, null et id inconnu ignorés ; user_state manquants (profil migré) créés.
do $$ declare a uuid := tests.make_user('Lock1'); b uuid := tests.make_user('Lock2'); begin
  delete from wm.user_state where user_id in (a, b);
  perform wm.lock_users(array[b, null, a, b, gen_random_uuid()]);
  assert (select count(*) from wm.user_state where user_id in (a, b)) = 2, 'user_state non créés';
end $$;

-- market_guard : vérification humaine absente ou échue, rafale de mises, de mises en vente, ou de paquets (P3) → même 403.
do $$ declare u uuid := tests.make_user('Guard1'); v uuid := pg_temp.player('Guard2'); d jsonb;
  g text := 'select wm.market_guard(%L, %L)'; begin
  d := pg_temp.err(format(g, u, 'bid'));
  assert d = '{"status":403,"code":"human_verification_required","error":"Vérification anti-bot requise pour continuer.","message":"Vérification anti-bot requise pour continuer.","human_verification_required":true}'::jsonb,
    coalesce(d::text, 'accepté');
  assert pg_temp.err(format(g, u, 'list')) = d, 'vente sans vérification';
  assert pg_temp.err(format(g, v, 'bid')) is null and pg_temp.err(format(g, v, 'list')) is null, 'joueur vérifié refusé';
  update wm.user_state set human_verified_until = now() where user_id = v;
  assert pg_temp.err(format(g, v, 'bid')) = d, 'vérification échue acceptée';
  perform wm.set_human_verified(v);
  update wm.user_state set bid_window_count = 10, bid_window_start = now() where user_id = v;
  assert pg_temp.err(format(g, v, 'bid')) = d, 'rafale de mises acceptée';
  assert pg_temp.err(format(g, v, 'list')) is null, 'rafale de mises comptée pour les ventes';
  update wm.user_state set bid_window_start = now() - interval '61 seconds' where user_id = v;
  assert pg_temp.err(format(g, v, 'bid')) is null, 'fenêtre de mises échue refusée';
  update wm.user_state set list_window_count = 5, list_window_start = now() where user_id = v;
  assert pg_temp.err(format(g, v, 'list')) = d, 'rafale de ventes acceptée';
  update wm.user_state set list_window_count = 0, open_window_count = 30, open_window_start = now() where user_id = v;
  assert pg_temp.err(format(g, v, 'bid')) = d and pg_temp.err(format(g, v, 'list')) = d, 'rafale de paquets acceptée';
end $$;

-- market_tick : la 10e mise de la fenêtre passe et retire la vérification (P3), la suivante est refusée ; fenêtre échue → 1 ;
-- set_human_verified remet les trois fenêtres à zéro.
do $$ declare u uuid := pg_temp.player('Tick1'); s wm.user_state; begin
  update wm.user_state set bid_window_count = 8, bid_window_start = now() - interval '30 seconds' where user_id = u;
  perform wm.market_tick(u, 'bid');
  assert (select bid_window_count = 9 and human_verified_until is not null from wm.user_state where user_id = u), '9e mise';
  perform wm.market_tick(u, 'bid');
  select * into s from wm.user_state where user_id = u;
  assert s.bid_window_count = 10 and s.bid_window_start = now() - interval '30 seconds' and s.human_verified_until is null, to_jsonb(s)::text;
  assert pg_temp.err(format('select wm.market_guard(%L, %L)', u, 'bid')) ->> 'code' = 'human_verification_required', '11e mise acceptée';
  update wm.user_state set bid_window_start = now() - interval '61 seconds' where user_id = u;
  perform wm.market_tick(u, 'bid');
  perform wm.market_tick(u, 'list');
  select * into s from wm.user_state where user_id = u;
  assert s.bid_window_count = 1 and s.bid_window_start = now() and s.list_window_count = 1 and s.list_window_start = now(), to_jsonb(s)::text;
  update wm.user_state set open_window_count = 7 where user_id = u;
  assert wm.set_human_verified(u) = '{"ok":true}'::jsonb;
  select * into s from wm.user_state where user_id = u;
  assert s.bid_window_count = 0 and s.list_window_count = 0 and s.bid_window_start is null and s.list_window_start is null
    and s.open_window_count = 0 and s.human_verified_until > now(), to_jsonb(s)::text;
end $$;

-- Review Focus, pile étiquetée : A (count 1, favorite, étiquetée, en avatar) part entière au séquestre ; B (count 3, deux étiquettes)
-- garde count 2 et ses étiquettes, le séquestre reçoit une unité sous un id neuf. Enchères posées à la main jusqu'à la Task 3.
do $$ declare s uuid := pg_temp.player('Pile1'); c uuid := pg_temp.card('Pile marché'); a public.user_cards; b public.user_cards;
  x uuid; y uuid; t1 uuid; t2 uuid; begin
  a := wm.grant_copy(s, c, false);
  b := wm.grant_copy(s, c, false);
  update public.user_cards set starred = true where id = a.id returning * into a;
  update public.user_cards set count = 3, starred = true where id = b.id returning * into b;
  insert into public.tags (user_id, name) values (s, 'pile-1') returning id into t1;
  insert into public.tags (user_id, name) values (s, 'pile-2') returning id into t2;
  insert into public.user_card_tags (user_card_id, tag_id) values (a.id, t1), (b.id, t1), (b.id, t2);
  update public.profiles set avatar_user_card_id = a.id where id = s;
  assert (select copies from wm.user_rarity_counts where user_id = s and snapshot_rarity = 'R' and not is_shiny) = 4, 'compteur avant';
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, snapshot_atk, snapshot_def, base_amount, listing_base_amount, end_at)
  values (s, c, a.id, a.snapshot_rarity, a.snapshot_atk, a.snapshot_def, 10, 10, now() + interval '1 hour'),
         (s, c, b.id, b.snapshot_rarity, b.snapshot_atk, b.snapshot_def, 20, 20, now() + interval '3 hours');
  select id into x from public.auctions where user_card_id = a.id;
  select id into y from public.auctions where user_card_id = b.id;
  perform wm.escrow_put(x, a, 60);
  assert not exists (select from public.user_cards where id = a.id) and not exists (select from public.user_card_tags where user_card_id = a.id),
    'copie A ou ses étiquettes encore là';
  assert (select avatar_user_card_id from public.profiles where id = s) is null, 'avatar resté sur la copie partie';
  assert (select user_card = to_jsonb(a) and duration_minutes = 60 from wm.auction_escrow where auction_id = x), 'séquestre de A';
  assert (select copies from wm.user_rarity_counts where user_id = s and snapshot_rarity = 'R' and not is_shiny) = 3, 'compteur après A';
  perform wm.escrow_put(y, b, 180);
  assert (select count = 2 and starred from public.user_cards where id = b.id), 'pile B';
  assert (select count(*) from public.user_card_tags where user_card_id = b.id) = 2, 'étiquettes de B perdues';
  assert (select user_card - 'id' = to_jsonb(b) - 'id' || '{"count":1}' and user_card ->> 'id' <> b.id::text and duration_minutes = 180
          from wm.auction_escrow where auction_id = y), 'séquestre de B';
  assert (select copies from wm.user_rarity_counts where user_id = s and snapshot_rarity = 'R' and not is_shiny) = 2, 'compteur après B';
  perform pg_temp.inv('séquestre');
end $$;

-- Notifications, avant toute sortie du séquestre : data = les cinq clés de M3-8 (card_title figé, wikipedia_title du catalogue),
-- end_at en plus pour wishlist_listed, amount absent quand il est nul ; ids null ignorés.
do $$ declare s uuid := (select id from public.profiles where username = 'Pile1'); o uuid := pg_temp.player('Notif1');
  x uuid := (select id from public.auctions where seller_id = s and base_amount = 10); n public.notifications; begin
  update public.cards set wikipedia_title = 'Pile marché (renommée)' where wikipedia_title = 'Pile marché';
  assert wm.notify_auction(array[o, null], 'auction_outbid', x, 11) = 1;
  select * into n from public.notifications where user_id = o and type = 'auction_outbid';
  assert n.data = jsonb_build_object('auction_id', x, 'card_id', (select card_id from public.auctions where id = x), 'card_title', 'Pile marché',
    'wikipedia_title', 'Pile marché (renommée)', 'amount', 11) and not n.read, n.data::text;
  assert wm.notify_auction(array[o], 'wishlist_listed', x, 10) = 1;
  assert (select data = n.data || jsonb_build_object('amount', 10, 'end_at', (select end_at from public.auctions where id = x))
          from public.notifications where user_id = o and type = 'wishlist_listed'), 'wishlist_listed';
  assert wm.notify_auction(array[s], 'auction_unsold', x) = 1;
  assert (select data = n.data - 'amount' from public.notifications where user_id = s and type = 'auction_unsold'), 'auction_unsold';
  assert wm.notify_auction(array[null]::uuid[], 'auction_won', x, 5) = 0, 'notification sans joueur';
end $$;

-- Sorties : nouvelle ligne (id neuf, count 1, pas favorite, sans étiquettes), obtained_at et snapshot_* d'origine, plus de séquestre.
-- Le gagnant reçoit la copie à l'obtained_at passé. Séquestre absent → erreur interne, jamais P0001.
do $$ declare s uuid := (select id from public.profiles where username = 'Pile1'); g uuid := pg_temp.player('Gagnant1');
  x uuid := (select id from public.auctions where seller_id = s and base_amount = 10);
  y uuid := (select id from public.auctions where seller_id = s and base_amount = 20);
  ex jsonb := (select user_card from wm.auction_escrow where auction_id = x);
  ey jsonb := (select user_card from wm.auction_escrow where auction_id = y);
  seen uuid[] := array(select id from public.user_cards where user_id = s) || (ex ->> 'id')::uuid || (ey ->> 'id')::uuid
    || (select array_agg(user_card_id) from public.auctions where seller_id = s);
  u public.user_cards; e text; m text; begin
  u := wm.escrow_release(x, s);
  assert u.id <> all (seen) and u.user_id = s and u.count = 1 and not u.starred, to_jsonb(u)::text;
  assert to_jsonb(u) - array['id', 'starred'] = ex - array['id', 'starred'], 'copie rendue différente de l''originale';
  assert not exists (select from public.user_card_tags where user_card_id = u.id), 'étiquettes sur la copie rendue';
  assert not exists (select from wm.auction_escrow where auction_id = x), 'séquestre de x encore là';
  update public.auctions set status = 'cancelled' where id = x;
  perform pg_temp.inv('rendue au vendeur');
  u := wm.escrow_release(y, g, '2026-10-21 12:00+00');
  assert u.id <> all (seen) and u.user_id = g and u.count = 1 and not u.starred and u.obtained_at = '2026-10-21 12:00+00', to_jsonb(u)::text;
  assert to_jsonb(u) - array['id', 'user_id', 'starred', 'obtained_at'] = ey - array['id', 'user_id', 'starred', 'obtained_at'], 'copie gagnée';
  assert not exists (select from wm.auction_escrow where auction_id = y), 'séquestre de y encore là';
  update public.auctions set status = 'cancelled' where id = y;
  perform pg_temp.inv('gagnée');
  begin
    perform wm.escrow_release(x, s);
    assert false, 'séquestre absent accepté';
  exception when others then
    get stacked diagnostics e = returned_sqlstate, m = message_text;
    assert e <> 'P0001' and m = 'séquestre absent pour ' || x, e || ' ' || m;
  end;
end $$;

-- min_next_bid : base sans mise, puis max(ceil(mise × 1,1), mise + 1) calculé en numeric (P6) ; null hors active.
do $$ declare a public.auctions := jsonb_populate_record(null::public.auctions, '{"status":"active","base_amount":37}'); begin
  assert wm.min_next_bid(a) = 37, 'sans mise';
  a.current_bid := 100; assert wm.min_next_bid(a) = 110, '100 → ' || wm.min_next_bid(a);
  a.current_bid := 1; assert wm.min_next_bid(a) = 2, '1 → ' || wm.min_next_bid(a);
  a.current_bid := 10; assert wm.min_next_bid(a) = 11, '10 → ' || wm.min_next_bid(a);
  a.current_bid := 9; assert wm.min_next_bid(a) = 10, '9 → ' || wm.min_next_bid(a);
  a.status := 'cancelled'; assert wm.min_next_bid(a) is null, 'terminée';
end $$;

-- auction_json : 21 colonnes + 7 clés calculées (M3-6, P5), carte à 12 clés, current_bidder null sans mise.
do $$ declare s uuid := pg_temp.player('Json1'); b uuid := pg_temp.player('Json2'); c uuid := pg_temp.card('Objet marché', 'UR');
  k public.user_cards := wm.grant_copy(s, c, false); a public.auctions; r jsonb; begin
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, snapshot_atk, snapshot_def, base_amount, listing_base_amount, end_at)
  values (s, c, k.id, k.snapshot_rarity, k.snapshot_atk, k.snapshot_def, 15, 15, now() + interval '1 hour') returning * into a;
  perform wm.escrow_put(a.id, k, 60);
  r := wm.auction_json(a);
  assert r ?& array['id', 'seller_id', 'card_id', 'user_card_id', 'snapshot_rarity', 'snapshot_atk', 'snapshot_def', 'snapshot_search_document',
    'is_shiny', 'base_amount', 'listing_base_amount', 'base_repriced_at', 'current_bid', 'current_bidder_id', 'bids_count', 'final_price',
    'status', 'end_at', 'created_at', 'settled_at', 'winner_id', 'bid_count', 'buyer_id', 'card', 'current_bidder', 'effective_bid',
    'min_next_bid', 'seller'] and (select count(*) from jsonb_object_keys(r)) = 28,
    (select string_agg(x, ', ' order by x) from jsonb_object_keys(r) x);
  assert r -> 'card' = (select jsonb_build_object('id', id, 'wikipedia_title', wikipedia_title, 'wikipedia_url', wikipedia_url, 'rarity', rarity,
    'category', category, 'image_url', image_url, 'hide_image', hide_image, 'nsfw_image', nsfw_image, 'atk', atk, 'def', def, 'q_score', q_score,
    'pageviews', pageviews) from public.cards where id = c), r -> 'card' #>> '{}';
  assert r -> 'seller' = jsonb_build_object('id', s, 'username', 'Json1') and r -> 'current_bidder' = 'null'::jsonb
    and r -> 'effective_bid' = '15' and r -> 'min_next_bid' = '15' and r -> 'bid_count' = '0' and r -> 'buyer_id' = 'null'::jsonb, r::text;
  a.current_bid := 40; a.current_bidder_id := b; a.bids_count := 2; a.winner_id := b;
  r := wm.auction_json(a);
  assert r -> 'current_bidder' = '{"username":"Json2"}' and r -> 'effective_bid' = '40' and r -> 'min_next_bid' = '44'
    and r -> 'bid_count' = '2' and r ->> 'buyer_id' = b::text, r::text;
  perform pg_temp.inv('objet Auction');
end $$;

-- Invariants du marché (M3-26) sur une vraie réservation, puis chaque violation forcée, vérifiée et annulée.
do $$ declare s uuid := pg_temp.player('Inv1'); b uuid := pg_temp.player('Inv2', 100); c uuid := pg_temp.card('Invariants marché');
  k public.user_cards := wm.grant_copy(s, c, false); x uuid; m uuid; e wm.auction_escrow; d jsonb; begin
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, snapshot_atk, snapshot_def, base_amount, listing_base_amount, end_at)
  values (s, c, k.id, k.snapshot_rarity, k.snapshot_atk, k.snapshot_def, 10, 10, now() + interval '1 hour') returning id into x;
  perform wm.escrow_put(x, k, 60);
  insert into public.auction_bids (auction_id, bidder_id, amount) values (x, b, 50) returning id into m;
  perform wm.wallet_apply(b, -50, 'bid', 'bid:' || m);
  update public.auctions set current_bid = 50, current_bidder_id = b, bids_count = 1 where id = x;
  perform pg_temp.inv('réservation');
  update public.auctions set current_bid = 51 where id = x;
  d := wm.check_invariants();
  assert d @> jsonb_build_array('{"check":"market_money","ledger":-50,"held":51}'::jsonb,
    jsonb_build_object('check', 'reservation', 'auction_id', x, 'current_bid', 51, 'unrefunded', '[50]'::jsonb))
    and jsonb_array_length(d) = 2, d::text;
  update public.auctions set current_bid = 50 where id = x;
  delete from wm.auction_escrow where auction_id = x returning * into e;
  d := wm.check_invariants();
  assert d = jsonb_build_array(jsonb_build_object('check', 'escrow', 'auction_id', x, 'problem', 'missing')), d::text;
  insert into wm.auction_escrow select (e).*;
  update public.auctions set status = 'cancelled' where id = x;
  d := wm.check_invariants();
  assert d @> jsonb_build_array(jsonb_build_object('check', 'escrow', 'auction_id', x, 'problem', 'orphan')), d::text;
  update public.auctions set status = 'active' where id = x;
  insert into public.user_cards select (jsonb_populate_record(null::public.user_cards, e.user_card)).*;
  d := wm.check_invariants();
  assert d = jsonb_build_array(jsonb_build_object('check', 'escrow', 'auction_id', x, 'problem', 'owned')), d::text;
  delete from public.user_cards where id = (e.user_card ->> 'id')::uuid;
  perform pg_temp.inv('invariants rétablis');
end $$;
