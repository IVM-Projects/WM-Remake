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
do $$ declare u uuid := pg_temp.player('Tick1'); s wm.user_state; k text; m text; begin
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
  -- Plafond des mises en vente : la 5e de la fenêtre retire la vérification, la 6e est refusée.
  update wm.user_state set list_window_count = 4, list_window_start = now() - interval '10 seconds' where user_id = u;
  perform wm.market_tick(u, 'list');
  select * into s from wm.user_state where user_id = u;
  assert s.list_window_count = 5 and s.human_verified_until is null, to_jsonb(s)::text;
  assert pg_temp.err(format('select wm.market_guard(%L, %L)', u, 'list')) ->> 'code' = 'human_verification_required', '6e mise en vente acceptée';
  -- Rafale inconnue : erreur interne, jamais un compteur écrit au hasard ni une garde passée sans contrôle.
  foreach k in array array['market_guard', 'market_tick'] loop
    begin
      execute format('select wm.%I(%L, %L)', k, u, 'pack');
      assert false, k || ' : rafale inconnue acceptée';
    exception when sqlstate 'XX000' then
      get stacked diagnostics m = message_text;
      assert m = 'rafale inconnue : pack', m;
    end;
  end loop;
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
  o uuid := pg_temp.player('Inv3'); k public.user_cards := wm.grant_copy(s, c, false); x uuid; m uuid; m2 uuid; e wm.auction_escrow;
  d jsonb; begin
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
  -- Réservation lue au grand livre ; chaque scénario est annulé par sa sous-transaction (WMT00), d survit à l'annulation.
  -- (a) Débit bid:<m> porté par un autre joueur que le miseur (devenu meneur) : aucune réservation.
  begin
    update public.auction_bids set bidder_id = o where id = m;
    update public.auctions set current_bidder_id = o where id = x;
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d = jsonb_build_array(jsonb_build_object('check', 'reservation', 'auction_id', x, 'current_bid', 50, 'unrefunded', '[]'::jsonb)), d::text;
  -- (b) Mise de 50 débitée de 40 seulement (m remboursée) : la réservation vaut 40, pas le montant de la ligne de mise.
  begin
    insert into public.auction_bids (auction_id, bidder_id, amount) values (x, b, 50) returning id into m2;
    perform wm.wallet_apply(b, 50, 'refund', 'refund:' || m);
    perform wm.wallet_apply(b, -40, 'bid', 'bid:' || m2);
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d @> jsonb_build_array(jsonb_build_object('check', 'reservation', 'auction_id', x, 'current_bid', 50, 'unrefunded', '[40]'::jsonb),
    '{"check":"market_money","ledger":-40,"held":50}'::jsonb) and jsonb_array_length(d) = 2, d::text;
  -- (c) La réservation restante n'est pas celle du meneur.
  begin
    update public.auctions set current_bidder_id = o where id = x;
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d = jsonb_build_array(jsonb_build_object('check', 'reservation', 'auction_id', x, 'current_bid', 50, 'unrefunded', '[50]'::jsonb)), d::text;
  perform pg_temp.inv('scénarios de réservation annulés');
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

-- Mise en vente, retrait, baisse de prix (1610).
-- Copie neuve mise en vente, fenêtre de rafale remise à zéro (la 5e mise en vente retirerait la vérification) ; renvoie l'id de l'enchère.
create function pg_temp.listing(p_seller uuid, p_card uuid, p_base int default 10, p_minutes int default 60) returns uuid language plpgsql as $$
declare k public.user_cards := wm.grant_copy(p_seller, p_card, false); begin
  update wm.user_state set list_window_count = 0 where user_id = p_seller;
  return wm.create_auction(p_seller, k.id, p_base, p_minutes) ->> 'auction_id';
end $$;

-- create_auction par id de copie (M3-14) : réponse {auction_id, id, end_at}, end_at = clock_timestamp() + durée (M3-11), snapshots et
-- brillance de la copie, document de recherche titre ‖ catégorie ‖ 300 premiers caractères du résumé, prix d'origine gardé, copie au
-- séquestre, une ligne de file d'alertes, rafale comptée.
do $$ declare s uuid := pg_temp.player('Vente1'); c uuid := pg_temp.card('Vente marché', 'SR', repeat('x', 400));
  k public.user_cards := wm.grant_copy(s, c, true); t0 timestamptz; t1 timestamptz; r jsonb; a public.auctions; begin
  t0 := clock_timestamp();
  r := wm.create_auction(s, k.id, 25, 60);
  t1 := clock_timestamp();
  assert (select array_agg(x order by x) from jsonb_object_keys(r) x) = array['auction_id', 'end_at', 'id'] and r -> 'id' = r -> 'auction_id',
    r::text;
  select * into a from public.auctions where id = (r ->> 'auction_id')::uuid;
  assert (r ->> 'end_at')::timestamptz = a.end_at and a.end_at between t0 + interval '60 minutes' and t1 + interval '60 minutes', r::text;
  assert a.seller_id = s and a.card_id = c and a.user_card_id = k.id and a.status = 'active' and a.snapshot_rarity = k.snapshot_rarity
    and a.snapshot_atk = k.snapshot_atk and a.snapshot_def = k.snapshot_def and a.is_shiny = k.is_shiny and a.is_shiny, to_jsonb(a)::text;
  assert a.snapshot_search_document = 'Vente marché Catégorie marché ' || repeat('x', 300)
    and length(a.snapshot_search_document) = length(k.snapshot_title) + 1 + length(k.snapshot_category) + 1 + 300, a.snapshot_search_document;
  assert a.base_amount = 25 and a.listing_base_amount = 25 and a.base_repriced_at is null and a.current_bid is null and a.bids_count = 0,
    to_jsonb(a)::text;
  assert not exists (select from public.user_cards where id = k.id), 'copie restée dans user_cards';
  assert (select user_card = to_jsonb(k) and duration_minutes = 60 from wm.auction_escrow where auction_id = a.id), 'séquestre';
  assert (select count(*) from wm.wishlist_alert_queue where auction_id = a.id and cursor_user is null and done_at is null) = 1, 'file d''alertes';
  assert (select list_window_count from wm.user_state where user_id = s) = 1, 'rafale non comptée';
  perform pg_temp.inv('mise en vente');
end $$;

-- Par id catalogue : la copie la plus ancienne du vendeur (obtained_at), pas la première créée ni celle d'un autre joueur.
-- Copie d'un autre joueur ou id inconnu → 403 42501.
do $$ declare s uuid := pg_temp.player('Vente2'); o uuid := pg_temp.player('Vente3'); c uuid := pg_temp.card('Catalogue marché');
  k1 public.user_cards := wm.grant_copy(s, c, false); k2 public.user_cards := wm.grant_copy(s, c, false);
  k3 public.user_cards := wm.grant_copy(s, c, false); ko public.user_cards := wm.grant_copy(o, c, false); r jsonb;
  d jsonb := '{"status":403,"code":"42501","error":"Vous ne possédez pas cette carte","message":"Vous ne possédez pas cette carte"}';
  q text := 'select wm.create_auction(%L, %L, 10, 60)'; begin
  update public.user_cards set obtained_at = now() - interval '3 days' where id = k2.id;
  update public.user_cards set obtained_at = now() - interval '2 days' where id = k3.id;
  update public.user_cards set obtained_at = now() - interval '1 day' where id = k1.id;
  update public.user_cards set obtained_at = now() - interval '4 days' where id = ko.id;
  r := wm.create_auction(s, c, 10, 60);
  assert (select user_card_id from public.auctions where id = (r ->> 'auction_id')::uuid) = k2.id, 'pas la plus ancienne';
  assert pg_temp.err(format(q, s, ko.id)) = d, 'copie d''un autre joueur';
  assert pg_temp.err(format(q, s, gen_random_uuid())) = d, 'id inconnu';
  assert exists (select from public.user_cards where id = ko.id), 'copie de l''autre joueur partie';
  perform pg_temp.inv('par id catalogue');
end $$;

-- Durée hors liste et mise de départ < 1, nulles comprises → 400, la durée d'abord ; 1440 accepté par l'API (M3-10).
do $$ declare s uuid := pg_temp.player('Vente4'); c uuid := pg_temp.card('Durée marché'); k public.user_cards := wm.grant_copy(s, c, false);
  q text := 'select wm.create_auction(%L, %L, %L, %L)'; x uuid;
  dd jsonb := '{"status":400,"code":"invalid_request","error":"Durée d''enchère invalide","message":"Durée d''enchère invalide"}';
  db jsonb := '{"status":400,"code":"invalid_request","error":"La mise de départ doit être d''au moins 1 wikibidou","message":"La mise de départ doit être d''au moins 1 wikibidou"}';
  begin
  assert pg_temp.err(format(q, s, k.id, 10, 45)) = dd and pg_temp.err(format(q, s, k.id, 10, null)) = dd
    and pg_temp.err(format(q, s, k.id, 0, 45)) = dd, 'durée invalide';
  assert pg_temp.err(format(q, s, k.id, 0, 60)) = db and pg_temp.err(format(q, s, k.id, null, 60)) = db, 'mise de départ invalide';
  x := pg_temp.listing(s, c, 1, 1440);
  assert (select duration_minutes = 1440 from wm.auction_escrow where auction_id = x)
    and (select base_amount = 1 and end_at > now() + interval '1439 minutes' from public.auctions where id = x), '1440';
end $$;

-- Limite (M3-14) : 5 enchères actives pour un gratuit, échue non réglée comprise, une retirée ne compte plus ; 10 pour un Pro.
do $$ declare f uuid := pg_temp.player('Limite1'); p uuid := pg_temp.player('Limite2', 0, true); c uuid := pg_temp.card('Limite marché');
  q text := 'select pg_temp.listing(%L, %L)'; x uuid; d jsonb; begin
  for i in 1 .. 5 loop x := pg_temp.listing(f, c); end loop;
  update public.auctions set end_at = now() - interval '1 minute' where id = x;
  d := pg_temp.err(format(q, f, c));
  assert d = '{"status":409,"error":"Limite de 5 enchères actives atteinte","message":"Limite de 5 enchères actives atteinte"}', coalesce(d::text, 'acceptée');
  perform wm.cancel_auction(f, x);
  perform pg_temp.listing(f, c);
  for i in 1 .. 10 loop perform pg_temp.listing(p, c); end loop;
  d := pg_temp.err(format(q, p, c));
  assert d = '{"status":409,"error":"Limite de 10 enchères actives atteinte","message":"Limite de 10 enchères actives atteinte"}', coalesce(d::text, 'acceptée');
  perform pg_temp.inv('limite');
end $$;

-- Rafale (M3-13, P3), Pro et fenêtre jamais remise à zéro : la 5e mise en vente passe et retire la vérification, la 6e reçoit le 403 sans
-- rien écrire ; vérifié à nouveau, elle passe.
do $$ declare s uuid := pg_temp.player('Rafale1', 0, true); c uuid := pg_temp.card('Rafale marché'); k public.user_cards; d jsonb; begin
  for i in 1 .. 5 loop
    perform wm.create_auction(s, (wm.grant_copy(s, c, false)).id, 10, 60);
    assert (select (human_verified_until is null) = (i = 5) from wm.user_state where user_id = s), 'vérification après la vente ' || i;
  end loop;
  k := wm.grant_copy(s, c, false);
  d := pg_temp.err(format('select wm.create_auction(%L, %L, 10, 60)', s, k.id));
  assert d ->> 'code' = 'human_verification_required' and d -> 'human_verification_required' = 'true', coalesce(d::text, '6e acceptée');
  assert exists (select from public.user_cards where id = k.id), 'copie partie malgré le refus';
  perform wm.set_human_verified(s);
  perform wm.create_auction(s, k.id, 10, 60);
  assert (select count(*) from public.auctions where seller_id = s) = 6, '6e refusée après vérification';
end $$;

-- Même Idempotency-Key : même réponse, une seule enchère, alors qu'une seconde copie permettrait une seconde vente.
do $$ declare s uuid := pg_temp.player('Idem1'); c uuid := pg_temp.card('Idem marché'); r jsonb; begin
  perform wm.grant_copy(s, c, false);
  perform wm.grant_copy(s, c, false);
  r := wm.create_auction(s, c, 10, 60, 'vente-1');
  assert wm.create_auction(s, c, 10, 60, 'vente-1') = r, 'réponse rejouée différente';
  assert (select count(*) from public.auctions where seller_id = s) = 1 and (select count(*) from public.user_cards where user_id = s) = 1,
    'vente rejouée';
end $$;

-- cancel_auction (M3-16) : inconnue → 404, autre joueur → 403, mise posée → 409, sans rien écrire ; échue sans mise → retirée.
do $$ declare s uuid := pg_temp.player('Retrait1'); o uuid := pg_temp.player('Retrait2', 100); c uuid := pg_temp.card('Retrait marché');
  x uuid := pg_temp.listing(s, c); y uuid := pg_temp.listing(s, c); q text := 'select wm.cancel_auction(%L, %L)'; d jsonb; r jsonb; begin
  d := pg_temp.err(format(q, s, gen_random_uuid()));
  assert d = '{"status":404,"error":"Enchère introuvable","message":"Enchère introuvable"}', coalesce(d::text, 'inconnue acceptée');
  d := pg_temp.err(format(q, o, x));
  assert d = '{"status":403,"error":"Seul le vendeur peut modifier cette enchère","message":"Seul le vendeur peut modifier cette enchère"}',
    coalesce(d::text, 'autre joueur accepté');
  perform wm.place_bid(o, y, 15);
  d := pg_temp.err(format(q, s, y));
  assert d = '{"status":409,"error":"Une enchère en cours ne peut pas être retirée","message":"Une enchère en cours ne peut pas être retirée"}',
    coalesce(d::text, 'retrait avec mise accepté');
  assert (select status = 'active' from public.auctions where id = y) and exists (select from wm.auction_escrow where auction_id = y)
    and (select status = 'active' from public.auctions where id = x), 'refus qui écrit';
  update public.auctions set end_at = now() - interval '1 minute' where id = x;
  r := wm.cancel_auction(s, x);
  assert r -> 'ok' = 'true' and (select status = 'cancelled' and settled_at is null from public.auctions where id = x)
    and exists (select from public.user_cards where id = (r ->> 'user_card_id')::uuid and user_id = s), r::text;
  perform pg_temp.inv('retrait');
end $$;

-- Review Focus, retrait d'une copie étiquetée (brillante, favorite, deux étiquettes, en avatar, obtenue le 1er janvier) : nouvelle ligne au
-- vendeur, id neuf, count 1, pas favorite, sans étiquettes, obtained_at et snapshots d'origine ; plus de séquestre, enchère cancelled.
-- Même clé rejouée → même réponse et une seule copie rendue ; sans clé → 409 « terminée ».
do $$ declare s uuid := pg_temp.player('Retrait3'); c uuid := pg_temp.card('Retrait étiqueté marché', 'UR');
  k public.user_cards := wm.grant_copy(s, c, true); x uuid; r jsonb; u public.user_cards; t1 uuid; t2 uuid; d jsonb; begin
  update public.user_cards set starred = true, obtained_at = '2026-01-01 08:00+00' where id = k.id returning * into k;
  insert into public.tags (user_id, name) values (s, 'retrait-1') returning id into t1;
  insert into public.tags (user_id, name) values (s, 'retrait-2') returning id into t2;
  insert into public.user_card_tags (user_card_id, tag_id) values (k.id, t1), (k.id, t2);
  update public.profiles set avatar_user_card_id = k.id where id = s;
  x := wm.create_auction(s, k.id, 10, 60) ->> 'auction_id';
  r := wm.cancel_auction(s, x, 'retrait-1');
  assert (select array_agg(e order by e) from jsonb_object_keys(r) e) = array['ok', 'user_card_id'] and r -> 'ok' = 'true', r::text;
  select * into u from public.user_cards where id = (r ->> 'user_card_id')::uuid;
  assert u.id <> k.id and u.user_id = s and u.count = 1 and not u.starred and u.obtained_at = '2026-01-01 08:00+00', to_jsonb(u)::text;
  assert to_jsonb(u) - array['id', 'starred'] = to_jsonb(k) - array['id', 'starred'], 'copie rendue différente de l''originale';
  assert not exists (select from public.user_card_tags where user_card_id = u.id), 'étiquettes sur la copie rendue';
  assert not exists (select from wm.auction_escrow where auction_id = x) and (select status from public.auctions where id = x) = 'cancelled',
    'séquestre ou statut';
  assert wm.cancel_auction(s, x, 'retrait-1') = r, 'rejeu différent';
  assert (select count(*) from public.user_cards where user_id = s) = 1, 'copie rendue deux fois';
  d := pg_temp.err(format('select wm.cancel_auction(%L, %L)', s, x));
  assert d = '{"status":409,"error":"Cette enchère est terminée","message":"Cette enchère est terminée"}', coalesce(d::text, 'second retrait accepté');
  perform pg_temp.inv('retrait étiqueté');
end $$;

-- reprice_auction (M3-17), 60 min et 25 au départ, donc n = 12 : après la moitié de la durée (lue au séquestre), prix dans [1, 12], une seule
-- fois, listing_base_amount gardé ; mise posée → 409 ; autre joueur → 403 ; inconnue → 404 ; retirée → 409 « terminée ».
do $$ declare s uuid := pg_temp.player('Baisse1'); o uuid := pg_temp.player('Baisse2', 100); c uuid := pg_temp.card('Baisse marché');
  x uuid := pg_temp.listing(s, c, 25, 60); y uuid := pg_temp.listing(s, c); q text := 'select wm.reprice_auction(%L, %L, %L)';
  n jsonb := '{"status":400,"code":"invalid_request","error":"Le nouveau prix doit être compris entre 1 et 12 wikibidous","message":"Le nouveau prix doit être compris entre 1 et 12 wikibidous"}';
  d jsonb; r jsonb; a public.auctions; begin
  d := pg_temp.err(format(q, s, x, 12));
  assert d = '{"status":409,"error":"Le prix ne peut être baissé qu''après la moitié de la durée","message":"Le prix ne peut être baissé qu''après la moitié de la durée"}',
    coalesce(d::text, 'baisse avant la moitié acceptée');
  update public.auctions set created_at = now() - interval '31 minutes' where id = x;
  assert pg_temp.err(format(q, s, x, 13)) = n and pg_temp.err(format(q, s, x, 0)) = n and pg_temp.err(format(q, s, x, null)) = n, 'hors [1, 12]';
  r := wm.reprice_auction(s, x, 12, 'baisse-1');
  select * into a from public.auctions where id = x;
  assert r = jsonb_build_object('ok', true, 'base_amount', 12, 'base_repriced_at', a.base_repriced_at) and a.base_repriced_at > now()
    and a.base_amount = 12 and a.listing_base_amount = 25, r::text;
  assert wm.reprice_auction(s, x, 12, 'baisse-1') = r, 'rejeu différent';
  d := pg_temp.err(format(q, s, x, 10));
  assert d = '{"status":409,"error":"Le prix a déjà été baissé une fois","message":"Le prix a déjà été baissé une fois"}',
    coalesce(d::text, 'seconde baisse acceptée');
  perform wm.place_bid(o, x, 12);
  d := pg_temp.err(format(q, s, x, 10));
  assert d = '{"status":409,"error":"Une enchère en cours ne peut pas être modifiée","message":"Une enchère en cours ne peut pas être modifiée"}',
    coalesce(d::text, 'baisse avec mise acceptée');
  assert pg_temp.err(format(q, o, y, 5)) ->> 'error' = 'Seul le vendeur peut modifier cette enchère', 'autre joueur accepté';
  assert pg_temp.err(format(q, s, gen_random_uuid(), 5)) ->> 'error' = 'Enchère introuvable', 'inconnue acceptée';
  perform wm.cancel_auction(s, y);
  assert pg_temp.err(format(q, s, y, 5)) ->> 'error' = 'Cette enchère est terminée', 'retirée acceptée';
  perform pg_temp.inv('baisse de prix');
end $$;

-- Mise (1620, M3-15).
-- A (100) mise 10 sur une base de 10 : réponse exacte, débit immédiat, placed_at = clock_timestamp() (P7). B (100) surenchérit à 11 :
-- A remboursé, minimum suivant 13 (ceil(12,1)), grand livre exact (débit de B, puis remboursement de A), une auction_outbid pour A.
do $$ declare s uuid := pg_temp.player('Mise1'); a uuid := pg_temp.player('Mise2', 100); b uuid := pg_temp.player('Mise3', 100);
  x uuid := pg_temp.listing(s, pg_temp.card('Mise marché')); t0 timestamptz; r jsonb; m1 uuid; m2 uuid; au public.auctions; begin
  t0 := clock_timestamp();
  r := wm.place_bid(a, x, 10);
  select * into au from public.auctions where id = x;
  assert r = jsonb_build_object('current_bid', 10, 'bidder_balance', 90, 'balance', 90, 'end_at', au.end_at, 'min_next_bid', 11), r::text;
  assert au.current_bid = 10 and au.current_bidder_id = a and au.bids_count = 1, to_jsonb(au)::text;
  select id into m1 from public.auction_bids where auction_id = x;
  assert (select bidder_id = a and amount = 10 and placed_at > t0 and placed_at < clock_timestamp() from public.auction_bids where id = m1),
    'ligne de mise ou placed_at';
  assert (select wikibidous_balance from public.profiles where id = a) = 90, 'solde de A';
  assert not exists (select from public.notifications where data ->> 'auction_id' = x::text), 'notification sans ancien meneur';
  r := wm.place_bid(b, x, 11);
  select * into au from public.auctions where id = x;
  assert r = jsonb_build_object('current_bid', 11, 'bidder_balance', 89, 'balance', 89, 'end_at', au.end_at, 'min_next_bid', 13), r::text;
  assert au.current_bid = 11 and au.current_bidder_id = b and au.bids_count = 2, to_jsonb(au)::text;
  select id into m2 from public.auction_bids where auction_id = x and bidder_id = b;
  assert (select array_agg(wikibidous_balance order by username) from public.profiles where id in (a, b)) = array[100, 89], 'soldes';
  assert (select jsonb_agg(jsonb_build_array(user_id, reason, ref, delta) order by id) from wm.wb_ledger
          where ref in ('bid:' || m1, 'refund:' || m1, 'bid:' || m2, 'refund:' || m2))
    = jsonb_build_array(jsonb_build_array(a, 'bid', 'bid:' || m1, -10), jsonb_build_array(b, 'bid', 'bid:' || m2, -11),
      jsonb_build_array(a, 'refund', 'refund:' || m1, 10)), 'grand livre';
  assert (select jsonb_agg(jsonb_build_array(user_id, data -> 'amount')) from public.notifications
          where type = 'auction_outbid' and data ->> 'auction_id' = x::text) = jsonb_build_array(jsonb_build_array(a, 11)), 'auction_outbid';
  perform pg_temp.inv('surenchère');
end $$;

-- Review Focus, montants (P6) : base 100 sans mise → 99 refusé (minimum 100) ; après 100 → 109 refusé (minimum 110), 110 passe ;
-- 1 → minimum 2 (mise nulle comprise).
do $$ declare s uuid := pg_temp.player('Montant1'); a uuid := pg_temp.player('Montant2', 1000); b uuid := pg_temp.player('Montant3', 1000);
  c uuid := pg_temp.card('Montant marché'); x uuid := pg_temp.listing(s, c, 100); y uuid := pg_temp.listing(s, c, 1);
  q text := 'select wm.place_bid(%L, %L, %L)'; d jsonb; begin
  d := pg_temp.err(format(q, a, x, 99));
  assert d = '{"status":409,"code":"bid_too_low","error":"Mise trop basse (minimum 100 wikibidous)","message":"Mise trop basse (minimum 100 wikibidous)","min":100}',
    coalesce(d::text, '99 accepté');
  assert wm.place_bid(a, x, 100) -> 'min_next_bid' = '110', 'minimum après 100';
  d := pg_temp.err(format(q, b, x, 109));
  assert d = '{"status":409,"code":"bid_too_low","error":"Mise trop basse (minimum 110 wikibidous)","message":"Mise trop basse (minimum 110 wikibidous)","min":110}',
    coalesce(d::text, '109 accepté');
  assert wm.place_bid(b, x, 110) -> 'current_bid' = '110', '110 refusé';
  assert wm.place_bid(a, y, 1) -> 'min_next_bid' = '2', 'minimum après 1';
  assert pg_temp.err(format(q, b, y, 1)) -> 'min' = '2' and pg_temp.err(format(q, b, y, null)) -> 'min' = '2', '1 ou null acceptés';
  assert wm.place_bid(b, y, 2) -> 'current_bid' = '2', '2 refusé';
  perform pg_temp.inv('montants');
end $$;

-- Refus exacts, dans l'ordre de M3-15 : inconnue → 404 ; échue ou invendue → 409 « terminée », avant le vendeur ; vendeur → 409 ; meneur
-- → 409, avant le minimum ; minimum avant la vérification humaine ; jamais vérifié → 403. Aucun n'écrit.
do $$ declare s uuid := pg_temp.player('Refus1'); a uuid := pg_temp.player('Refus2', 100); n uuid := tests.make_user('Refus3', 100);
  c uuid := pg_temp.card('Refus marché'); x uuid := pg_temp.listing(s, c); y uuid := pg_temp.listing(s, c); z uuid := pg_temp.listing(s, c);
  q text := 'select wm.place_bid(%L, %L, %L)'; d jsonb;
  fin jsonb := '{"status":409,"error":"Cette enchère est terminée","message":"Cette enchère est terminée"}'; begin
  d := pg_temp.err(format(q, a, gen_random_uuid(), 10));
  assert d = '{"status":404,"error":"Enchère introuvable","message":"Enchère introuvable"}', coalesce(d::text, 'inconnue acceptée');
  update public.auctions set end_at = now() - interval '1 minute' where id = y;
  assert pg_temp.err(format(q, a, y, 10)) = fin and pg_temp.err(format(q, s, y, 10)) = fin, 'échue acceptée';
  perform wm.escrow_release(z, s);
  update public.auctions set status = 'settled_unsold', settled_at = now() where id = z;
  assert pg_temp.err(format(q, a, z, 10)) = fin, 'invendue acceptée';
  d := pg_temp.err(format(q, s, x, 10));
  assert d = '{"status":409,"error":"Tu ne peux pas enchérir sur ta propre vente","message":"Tu ne peux pas enchérir sur ta propre vente"}',
    coalesce(d::text, 'vendeur accepté');
  perform wm.place_bid(a, x, 10);
  d := pg_temp.err(format(q, a, x, 1));
  assert d = '{"status":409,"error":"Tu es déjà en tête","message":"Tu es déjà en tête"}', coalesce(d::text, 'meneur accepté');
  assert pg_temp.err(format(q, n, x, 10)) ->> 'code' = 'bid_too_low', 'vérification avant le minimum';
  d := pg_temp.err(format(q, n, x, 11));
  assert d = '{"status":403,"code":"human_verification_required","error":"Vérification anti-bot requise pour continuer.","message":"Vérification anti-bot requise pour continuer.","human_verification_required":true}',
    coalesce(d::text, 'jamais vérifié accepté');
  assert (select count(*) from public.auction_bids where auction_id in (x, y, z)) = 1
    and (select current_bidder_id = a and current_bid = 10 from public.auctions where id = x)
    and (select wikibidous_balance from public.profiles where id = n) = 100, 'refus qui écrit';
  perform pg_temp.inv('refus de mise');
end $$;

-- Review Focus, mise refusée à mi-chemin : C (solde 5) mise 13, le minimum, alors que B mène à 11 → 409 insufficient_balance, et rien ne
-- reste : aucune ligne de mise, B en tête, aucun refund:<m2>, soldes, grand livre et notifications inchangés.
do $$ declare s uuid := pg_temp.player('MiChemin1'); b uuid := pg_temp.player('MiChemin2', 100); c uuid := pg_temp.player('MiChemin3', 5);
  x uuid := pg_temp.listing(s, pg_temp.card('Mi-chemin marché')); m2 uuid; l jsonb; d jsonb; begin
  perform wm.place_bid(b, x, 11);
  select id into m2 from public.auction_bids where auction_id = x;
  l := (select jsonb_agg(to_jsonb(w) order by id) from wm.wb_ledger w where user_id in (b, c));
  d := pg_temp.err(format('select wm.place_bid(%L, %L, 13)', c, x));
  assert d = '{"status":409,"code":"insufficient_balance","error":"Solde insuffisant","message":"Solde insuffisant"}', coalesce(d::text, 'acceptée');
  assert (select count(*) from public.auction_bids where auction_id = x) = 1, 'ligne de mise restée';
  assert (select current_bidder_id = b and current_bid = 11 and bids_count = 1 from public.auctions where id = x), 'meneur changé';
  assert not exists (select from wm.wb_ledger where ref = 'refund:' || m2), 'B remboursé';
  assert (select jsonb_agg(to_jsonb(w) order by id) from wm.wb_ledger w where user_id in (b, c)) = l, 'grand livre changé';
  assert (select array_agg(wikibidous_balance order by username) from public.profiles where id in (b, c)) = array[89, 5], 'soldes changés';
  assert not exists (select from public.notifications where data ->> 'auction_id' = x::text), 'notification restée';
  perform pg_temp.inv('mise refusée à mi-chemin');
end $$;

-- Anti-snipe (M3-15, M3-11) : à 5 s de la fin, end_at = ancien + 60 s exactement, et encore à la mise suivante ; à 30 s, inchangé.
do $$ declare s uuid := pg_temp.player('Snipe1'); a uuid := pg_temp.player('Snipe2', 100); b uuid := pg_temp.player('Snipe3', 100);
  x uuid := pg_temp.listing(s, pg_temp.card('Snipe marché')); e timestamptz; r jsonb; begin
  update public.auctions set end_at = clock_timestamp() + interval '5 seconds' where id = x returning end_at into e;
  r := wm.place_bid(a, x, 10);
  assert (select end_at from public.auctions where id = x) = e + interval '60 seconds' and (r ->> 'end_at')::timestamptz = e + interval '60 seconds',
    r::text;
  update public.auctions set end_at = clock_timestamp() + interval '5 seconds' where id = x returning end_at into e;
  perform wm.place_bid(b, x, 11);
  assert (select end_at from public.auctions where id = x) = e + interval '60 seconds', 'seconde mise dans la fenêtre';
  update public.auctions set end_at = clock_timestamp() + interval '30 seconds' where id = x returning end_at into e;
  r := wm.place_bid(a, x, 13);
  assert (select end_at from public.auctions where id = x) = e and (r ->> 'end_at')::timestamptz = e, '30 s restantes';
  perform pg_temp.inv('anti-snipe');
end $$;

-- Review Focus, rafale (M3-13, P3) : D (vérifié) mise sur 10 enchères, la 10e retire la vérification ; la 11e → 403 sans rien écrire, et les
-- paquets sont verrouillés avec ; vérifié à nouveau, elle passe. Deux vendeurs : 10 enchères actives au plus pour un Pro.
do $$ declare p uuid := pg_temp.player('RafaleMise1', 0, true); o uuid := pg_temp.player('RafaleMise2'); v uuid := pg_temp.player('RafaleMise3', 1000);
  c uuid := pg_temp.card('Rafale mise marché'); x uuid; d jsonb; begin
  for i in 1 .. 10 loop
    perform wm.place_bid(v, pg_temp.listing(p, c), 10);
    assert (select (human_verified_until is null) = (i = 10) from wm.user_state where user_id = v), 'vérification après la mise ' || i;
  end loop;
  x := pg_temp.listing(o, c);
  d := pg_temp.err(format('select wm.place_bid(%L, %L, 10)', v, x));
  assert d ->> 'code' = 'human_verification_required' and d -> 'human_verification_required' = 'true', coalesce(d::text, '11e acceptée');
  assert not exists (select from public.auction_bids where auction_id = x), '11e écrite';
  d := pg_temp.err(format('select wm.open_pack(%L, %L)', v, 'Europe/Paris'));
  assert d ->> 'status' = '403' and d ->> 'code' = 'human_verification_required', coalesce(d::text, 'paquet accepté');
  perform wm.set_human_verified(v);
  assert wm.place_bid(v, x, 10) -> 'current_bid' = '10', '11e refusée après vérification';
  assert (select count(*) from public.auction_bids where bidder_id = v) = 11 and (select wikibidous_balance from public.profiles where id = v) = 890,
    'mises de D';
  perform pg_temp.inv('rafale de mises');
end $$;

-- Même Idempotency-Key : même réponse, une seule ligne de mise, un seul débit (sans clé, la seconde serait « Tu es déjà en tête »).
do $$ declare s uuid := pg_temp.player('IdemMise1'); a uuid := pg_temp.player('IdemMise2', 100);
  x uuid := pg_temp.listing(s, pg_temp.card('Idem mise marché')); r jsonb; begin
  r := wm.place_bid(a, x, 10, 'mise-1');
  assert wm.place_bid(a, x, 10, 'mise-1') = r, 'réponse rejouée différente';
  assert (select count(*) from public.auction_bids where auction_id = x) = 1
    and (select count(*) from wm.wb_ledger where user_id = a and reason = 'bid') = 1
    and (select wikibidous_balance from public.profiles where id = a) = 90, 'mise rejouée';
  perform pg_temp.inv('mise idempotente');
end $$;

-- Règlement (1630, M3-18).
-- Les enchères échues des blocs précédents sont réglées d'abord : les comptes ci-dessous ne portent que sur celles de ce bloc.
-- Non échue → {id, status: active, settled: false}, rien ne change ; inconnue → null.
do $$ declare s uuid := pg_temp.player('Regle1'); x uuid; a jsonb; e jsonb; r jsonb; begin
  perform wm.settle_due_auctions(100000);
  x := pg_temp.listing(s, pg_temp.card('Règlement marché'));
  a := (select to_jsonb(u) from public.auctions u where id = x);
  e := (select to_jsonb(k) from wm.auction_escrow k where auction_id = x);
  r := wm.settle_auction(x);
  assert r = jsonb_build_object('id', x, 'status', 'active', 'settled', false), r::text;
  assert (select to_jsonb(u) from public.auctions u where id = x) = a and (select to_jsonb(k) from wm.auction_escrow k where auction_id = x) = e
    and not exists (select from public.notifications where data ->> 'auction_id' = x::text), 'non échue modifiée';
  assert wm.settle_auction(gen_random_uuid()) is null, 'inconnue';
end $$;

-- Review Focus, invendue : copie brillante, favorite, étiquetée, obtenue le 1er janvier, échue sans mise → settled_unsold, settled_at =
-- heure réelle (P7), nouvelle ligne au vendeur (id neuf, count 1, pas favorite, sans étiquettes, obtained_at d'origine), plus de séquestre,
-- une auction_unsold sans amount.
do $$ declare s uuid := pg_temp.player('Invendue1'); c uuid := pg_temp.card('Invendue marché', 'UR');
  k public.user_cards := wm.grant_copy(s, c, true); t uuid; x uuid; t0 timestamptz; r jsonb; a public.auctions; u public.user_cards; begin
  update public.user_cards set starred = true, obtained_at = '2026-01-01 08:00+00' where id = k.id returning * into k;
  insert into public.tags (user_id, name) values (s, 'invendue-1') returning id into t;
  insert into public.user_card_tags (user_card_id, tag_id) values (k.id, t);
  x := wm.create_auction(s, k.id, 10, 60) ->> 'auction_id';
  update public.auctions set end_at = now() - interval '1 minute' where id = x;
  t0 := clock_timestamp();
  r := wm.settle_auction(x);
  assert r = jsonb_build_object('id', x, 'status', 'settled_unsold', 'settled', true), r::text;
  select * into a from public.auctions where id = x;
  assert a.status = 'settled_unsold' and a.settled_at > t0 and a.settled_at < clock_timestamp() and a.winner_id is null
    and a.final_price is null, to_jsonb(a)::text;
  assert (select count(*) from public.user_cards where user_id = s) = 1, 'copies du vendeur';
  select * into u from public.user_cards where user_id = s;
  assert u.id <> k.id and u.count = 1 and not u.starred and u.obtained_at = '2026-01-01 08:00+00', to_jsonb(u)::text;
  assert to_jsonb(u) - array['id', 'starred'] = to_jsonb(k) - array['id', 'starred'], 'copie rendue différente de l''originale';
  assert not exists (select from public.user_card_tags where user_card_id = u.id), 'étiquettes sur la copie rendue';
  assert not exists (select from wm.auction_escrow where auction_id = x), 'séquestre encore là';
  assert (select jsonb_agg(jsonb_build_array(user_id, type, data ? 'amount')) from public.notifications where data ->> 'auction_id' = x::text)
    = jsonb_build_array(jsonb_build_array(s, 'auction_unsold', false)), 'auction_unsold';
  perform pg_temp.inv('invendue');
end $$;

-- Vendue (B mène à 11) → settled_sold, gagnant B, prix 11 ; copie chez B à obtained_at = settled_at ; vendeur crédité de 11 par settle:<id> ;
-- auction_won pour B et auction_sold pour le vendeur, amount 11. Idempotence : un second règlement → settled false, grand livre, copies et
-- notifications inchangés.
do $$ declare s uuid := pg_temp.player('Vendue1'); a uuid := pg_temp.player('Vendue2', 100); b uuid := pg_temp.player('Vendue3', 100);
  c uuid := pg_temp.card('Vendue marché'); x uuid := pg_temp.listing(s, c); r jsonb; au public.auctions; n bigint[]; begin
  perform wm.place_bid(a, x, 10);
  perform wm.place_bid(b, x, 11);
  update public.auctions set end_at = now() - interval '1 minute' where id = x;
  r := wm.settle_auction(x);
  assert r = jsonb_build_object('id', x, 'status', 'settled_sold', 'settled', true), r::text;
  select * into au from public.auctions where id = x;
  assert au.status = 'settled_sold' and au.winner_id = b and au.final_price = 11 and au.current_bid = 11 and au.settled_at > now(),
    to_jsonb(au)::text;
  assert (select count(*) from public.user_cards where user_id = b) = 1
    and (select count = 1 and not starred and card_id = c and obtained_at = au.settled_at from public.user_cards where user_id = b),
    'copie gagnée';
  assert not exists (select from wm.auction_escrow where auction_id = x), 'séquestre encore là';
  assert (select jsonb_agg(jsonb_build_array(user_id, delta, balance_after)) from wm.wb_ledger where ref = 'settle:' || x)
    = jsonb_build_array(jsonb_build_array(s, 11, 11)), 'crédit du vendeur';
  assert (select array_agg(wikibidous_balance order by username) from public.profiles where id in (s, a, b)) = array[11, 100, 89], 'soldes';
  assert (select jsonb_agg(jsonb_build_array(type, user_id, data -> 'amount') order by type) from public.notifications
          where data ->> 'auction_id' = x::text and type in ('auction_won', 'auction_sold'))
    = jsonb_build_array(jsonb_build_array('auction_sold', s, 11), jsonb_build_array('auction_won', b, 11)), 'auction_won et auction_sold';
  n := array[(select count(*) from wm.wb_ledger), (select count(*) from public.user_cards), (select count(*) from public.notifications)];
  r := wm.settle_auction(x);
  assert r = jsonb_build_object('id', x, 'status', 'settled_sold', 'settled', false), r::text;
  assert n = array[(select count(*) from wm.wb_ledger), (select count(*) from public.user_cards), (select count(*) from public.notifications)],
    'second règlement qui écrit';
  perform pg_temp.inv('vendue');
end $$;

-- settle_due_auctions : 3 échues (une avec mise) et 1 non échue → 3 ; p_limit 2 sur 3 → les 2 plus anciennes (end_at), puis 1, puis 0.
-- Séquestre supprimé à la main (P9) : cette enchère est sautée (sa sous-transaction est annulée, sans notification), les autres sont
-- réglées ; séquestre réinséré, elle se règle ensuite.
do $$ declare s uuid := pg_temp.player('Lot1', 0, true); b uuid := pg_temp.player('Lot2', 1000); c uuid := pg_temp.card('Lot marché');
  x uuid[]; e wm.auction_escrow; n int; l text := current_setting('client_min_messages'); begin
  x := array(select pg_temp.listing(s, c) from generate_series(1, 4));
  perform wm.place_bid(b, x[1], 10);
  update public.auctions set end_at = now() - interval '1 minute' where id = any (x[1:3]);
  n := wm.settle_due_auctions();
  assert n = 3, 'réglées : ' || n;
  assert (select array_agg(status::text order by array_position(x, id)) from public.auctions where id = any (x))
    = array['settled_sold', 'settled_unsold', 'settled_unsold', 'active'], 'statuts';
  x := array(select pg_temp.listing(s, c) from generate_series(1, 3));
  update public.auctions set end_at = now() - make_interval(mins => 10 - array_position(x, id)) where id = any (x);
  assert wm.settle_due_auctions(2) = 2, 'limite 2';
  assert (select array_agg(status::text order by array_position(x, id)) from public.auctions where id = any (x))
    = array['settled_unsold', 'settled_unsold', 'active'], 'pas les plus anciennes';
  assert wm.settle_due_auctions(2) = 1 and wm.settle_due_auctions(2) = 0, 'reste';
  x := array(select pg_temp.listing(s, c) from generate_series(1, 3));
  perform wm.place_bid(b, x[2], 10);
  update public.auctions set end_at = now() - interval '1 minute' where id = any (x);
  delete from wm.auction_escrow where auction_id = x[2] returning * into e;
  perform set_config('client_min_messages', 'error', true);  -- avertissement attendu de la sous-transaction en erreur
  n := wm.settle_due_auctions();
  perform set_config('client_min_messages', l, true);
  assert n = 2, 'réglées malgré le séquestre absent : ' || n;
  assert (select array_agg(status::text order by array_position(x, id)) from public.auctions where id = any (x))
    = array['settled_unsold', 'active', 'settled_unsold'], 'statuts avec séquestre absent';
  assert not exists (select from public.notifications where data ->> 'auction_id' = x[2]::text)
    and not exists (select from wm.wb_ledger where ref = 'settle:' || x[2]), 'sous-transaction en erreur qui écrit';
  insert into wm.auction_escrow select (e).*;
  perform pg_temp.inv('lot');
  assert wm.settle_auction(x[2]) ->> 'settled' = 'true', 'réglée après le retour du séquestre';
  perform pg_temp.inv('lot réglé');
end $$;

-- settle_request (P8, P11) : inconnue ou retirée → 404 ; non échue → 409 ; échue → {auction} réglée, owned true pour le gagnant, false pour un
-- tiers ; même clé → même réponse ; sans clé → même réponse ; un seul crédit du vendeur.
do $$ declare s uuid := pg_temp.player('Finaliser1'); b uuid := pg_temp.player('Finaliser2', 100); o uuid := pg_temp.player('Finaliser3');
  c uuid := pg_temp.card('Finaliser marché'); x uuid := pg_temp.listing(s, c); y uuid := pg_temp.listing(s, c);
  q text := 'select wm.settle_request(%L, %L)'; d jsonb; r jsonb; a public.auctions; begin
  d := pg_temp.err(format(q, o, gen_random_uuid()));
  assert d = '{"status":404,"error":"Enchère introuvable","message":"Enchère introuvable"}', coalesce(d::text, 'inconnue acceptée');
  perform wm.cancel_auction(s, y);
  assert pg_temp.err(format(q, o, y)) = d, 'retirée acceptée';
  perform wm.place_bid(b, x, 10);
  d := pg_temp.err(format(q, o, x));
  assert d = '{"status":409,"error":"L''enchère n''est pas encore terminée","message":"L''enchère n''est pas encore terminée"}',
    coalesce(d::text, 'non échue acceptée');
  assert (select status = 'active' and settled_at is null from public.auctions where id = x), 'non échue réglée';
  update public.auctions set end_at = now() - interval '1 minute' where id = x;
  r := wm.settle_request(b, x, 'finaliser-1');
  select * into a from public.auctions where id = x;
  assert r = jsonb_build_object('auction', wm.auction_json(a) || '{"owned": true}') and a.status = 'settled_sold' and a.winner_id = b, r::text;
  assert wm.settle_request(b, x, 'finaliser-1') = r, 'rejeu différent';
  assert wm.settle_request(b, x) = r, 'rappel sans clé différent';
  assert wm.settle_request(o, x) = jsonb_build_object('auction', r -> 'auction' || '{"owned": false}'), 'tiers';
  assert (select count(*) from wm.wb_ledger where ref = 'settle:' || x) = 1, 'vendeur crédité plusieurs fois';
  perform pg_temp.inv('settle_request');
end $$;

-- Lectures (1640, M3-19).
-- Ids d'un tableau d'objets Auction, dans l'ordre de la réponse.
create function pg_temp.ids(p jsonb) returns uuid[] language sql as $$
  select coalesce(array_agg((e ->> 'id')::uuid order by o), '{}') from jsonb_array_elements(p) with ordinality x (e, o)
$$;

-- market_list : cinq enchères actives d'« Électricité statique » aux dates et prix connus (x2 de base 10 avec une mise à 40, x4 échue non
-- réglée, x3 et x5 en UR), une enchère d'une autre carte (card_id strict). Chaque appel filtre sur une carte du bloc (les enchères actives
-- des blocs précédents compteraient), sauf le dernier, comparé au nombre réel d'enchères actives.
do $$ declare s uuid := pg_temp.player('Liste1'); b uuid := pg_temp.player('Liste2', 100); t uuid := pg_temp.player('Liste3');
  c uuid := pg_temp.card('Électricité statique'); o uuid := pg_temp.card('Électricité dynamique'); x uuid[]; y uuid; r jsonb; d jsonb;
  q text := 'select wm.market_list(p_page => %L, p_sort => %L, p_q => %L, p_card_id => %L)';
  e400 text := '{"status":400,"code":"invalid_request","error":"%1$s","message":"%1$s"}'; begin
  x := array(select pg_temp.listing(s, c, v) from unnest(array[50, 10, 30, 20, 60]) v);
  y := pg_temp.listing(t, o);
  perform wm.place_bid(b, x[2], 40);
  update public.auctions a set created_at = now() - make_interval(hours => 6 - v.i::int), end_at = now() + v.e
  from unnest(x, array[interval '5 hours', '1 hour', '3 hours', '-1 minute', '2 hours']) with ordinality v (id, e, i) where a.id = v.id;
  update public.auctions set snapshot_rarity = 'UR' where id in (x[3], x[5]);
  -- Tris : recent (défaut), prix effectif (x2 classée à 40, sa mise, pas à 10), fin la plus proche avec l'échue non réglée en tête.
  r := wm.market_list(p_card_id => c);
  assert r - 'auctions' = '{"hasMore":false,"total":5}' and pg_temp.ids(r -> 'auctions') = array[x[5], x[4], x[3], x[2], x[1]], r::text;
  assert r -> 'auctions' = (select jsonb_agg(wm.auction_json(a) order by a.created_at desc) from public.auctions a where a.id = any (x)),
    'objets Auction';
  assert not exists (select from jsonb_array_elements(r -> 'auctions') e where e ? 'owned' or e -> 'card' ? 'summary'), 'owned ou summary';
  assert pg_temp.ids(wm.market_list(p_sort => 'price_asc', p_card_id => c) -> 'auctions') = array[x[4], x[3], x[2], x[1], x[5]], 'price_asc';
  assert pg_temp.ids(wm.market_list(p_sort => 'price_desc', p_card_id => c) -> 'auctions') = array[x[5], x[1], x[2], x[3], x[4]], 'price_desc';
  assert pg_temp.ids(wm.market_list(p_sort => 'ending_soon', p_card_id => c) -> 'auctions') = array[x[4], x[2], x[5], x[3], x[1]], 'ending_soon';
  -- Filtres : rareté figée ; card_id strict ; q sans accents ni casse, %q% même à 2 caractères, jokers LIKE pris à la lettre.
  r := wm.market_list(p_rarity => '{UR}', p_card_id => c);
  assert pg_temp.ids(r -> 'auctions') = array[x[5], x[3]] and r -> 'total' = '2', r::text;
  r := wm.market_list(p_card_id => o);
  assert pg_temp.ids(r -> 'auctions') = array[y] and r -> 'total' = '1', r::text;
  assert pg_temp.ids(wm.market_list(p_q => 'electricite', p_card_id => c) -> 'auctions') = array[x[5], x[4], x[3], x[2], x[1]], 'q sans accent';
  assert pg_temp.ids(wm.market_list(p_q => ' ÉLECTRICITÉ ', p_card_id => o) -> 'auctions') = array[y], 'q accentué';
  assert (wm.market_list(p_q => 'st', p_card_id => c) ->> 'total')::int = 5, 'q à 2 caractères';
  assert wm.market_list(p_q => 'magnetisme', p_card_id => c) = '{"auctions":[],"hasMore":false,"total":0}', 'q sans correspondance';
  assert wm.market_list(p_q => 'el_ct', p_card_id => c) ->> 'total' = '0', '_ pris comme joker';
  assert wm.market_list(p_q => 'el%ue', p_card_id => c) ->> 'total' = '0', '% pris comme joker';
  assert wm.market_list(p_q => 'el\ec', p_card_id => c) ->> 'total' = '0', '\ pris comme échappement';
  assert wm.market_list(p_q => '%%', p_card_id => c) = '{"auctions":[],"hasMore":false,"total":0}', '%% sans lettre ni chiffre';
  -- Refus.
  d := pg_temp.err(format(q, 0, 'recent', null, c));
  assert d = format(e400, 'La page commence à 1')::jsonb, coalesce(d::text, 'page 0 acceptée');
  d := pg_temp.err(format(q, 1, 'xyz', null, c));
  assert d = format(e400, 'Tri inconnu')::jsonb, coalesce(d::text, 'tri inconnu accepté');
  d := pg_temp.err(format(q, 1, 'recent', 'a', c));
  assert d = format(e400, 'La recherche demande au moins 2 caractères')::jsonb, coalesce(d::text, 'q d''un caractère accepté');
  -- Limite ramenée dans 1..50, hasMore = page × limite < total.
  r := wm.market_list(p_limit => 2, p_card_id => c);
  assert pg_temp.ids(r -> 'auctions') = array[x[5], x[4]] and r - 'auctions' = '{"hasMore":true,"total":5}', r::text;
  r := wm.market_list(p_page => 3, p_limit => 2, p_card_id => c);
  assert pg_temp.ids(r -> 'auctions') = array[x[1]] and r - 'auctions' = '{"hasMore":false,"total":5}', r::text;
  assert pg_temp.ids(wm.market_list(p_limit => 0, p_card_id => c) -> 'auctions') = array[x[5]], 'limite 0';
  assert (wm.market_list() ->> 'total')::int = (select count(*) from public.auctions where status = 'active'), 'sans filtre';
  perform pg_temp.inv('liste');
end $$;

-- 51 enchères actives d'une carte (six vendeurs Pro), plus une retirée, une invendue et une vendue : p_limit 100 ramené à 50, hasMore, puis
-- la 51e en page 2 ; les deux pages font les 51 actives, sans doublon (création identique, départage par id) ; les terminées n'apparaissent
-- jamais.
do $$ declare c uuid := pg_temp.card('Pagination marché'); s uuid := pg_temp.player('Page0'); b uuid := pg_temp.player('Page9', 100);
  p uuid[] := array(select pg_temp.player('Page' || i, 0, true) from generate_series(1, 6) i); x uuid[]; z uuid[]; r jsonb; r2 jsonb; begin
  z := array(select pg_temp.listing(s, c) from generate_series(1, 3));
  perform wm.cancel_auction(s, z[1]);
  perform wm.place_bid(b, z[3], 10);
  update public.auctions set end_at = now() - interval '1 minute' where id in (z[2], z[3]);
  perform wm.settle_auction(z[2]);
  perform wm.settle_auction(z[3]);
  assert (select array_agg(status::text order by array_position(z, id)) from public.auctions where id = any (z))
    = array['cancelled', 'settled_unsold', 'settled_sold'], 'terminées';
  x := array(select pg_temp.listing(p[(i - 1) / 10 + 1], c) from generate_series(1, 51) i);
  r := wm.market_list(p_limit => 100, p_card_id => c);
  assert jsonb_array_length(r -> 'auctions') = 50 and r - 'auctions' = '{"hasMore":true,"total":51}', (r - 'auctions')::text;
  r2 := wm.market_list(p_page => 2, p_limit => 100, p_card_id => c);
  assert jsonb_array_length(r2 -> 'auctions') = 1 and r2 - 'auctions' = '{"hasMore":false,"total":51}', r2::text;
  assert pg_temp.ids(r -> 'auctions') || pg_temp.ids(r2 -> 'auctions') = array(select i from unnest(x) i order by i), 'pages';
  perform pg_temp.inv('pagination');
end $$;

-- market_overlay : seulement les cartes possédées, dans l'ordre demandé ; la seule copie mise en vente (au séquestre) ne compte pas.
do $$ declare u uuid := pg_temp.player('Overlay1'); c1 uuid := pg_temp.card('Overlay marché 1'); c2 uuid := pg_temp.card('Overlay marché 2');
  c3 uuid := pg_temp.card('Overlay marché 3'); c4 uuid := pg_temp.card('Overlay marché 4'); r jsonb; begin
  perform wm.grant_copy(u, c1, false);
  perform wm.grant_copy(u, c3, false);
  perform pg_temp.listing(u, c4);
  r := wm.market_overlay(u, array[c3, c2, c4, c1]);
  assert r = jsonb_build_object('ownedCardIds', jsonb_build_array(c3, c1)), r::text;
  assert wm.market_overlay(u, '{}') = '{"ownedCardIds":[]}', 'liste vide';
end $$;

-- market_mine_lists : P mise sur quatre enchères de S (en tête après une surenchère, surenchéri, gagnée, perdue) et vend trois copies
-- (vendue, invendue, retirée) plus deux en cours. bidding par dernière mise de P, my_last_bid = sa dernière mise ; history par
-- coalesce(settled_at, created_at) desc (P26) ; owned posé par le SQL (P11) : seule la carte gagnée est à P parmi celles de bidding.
do $$ declare p uuid := pg_temp.player('Mes1', 1000); s uuid := pg_temp.player('Mes2'); q uuid := pg_temp.player('Mes3', 1000);
  b uuid := pg_temp.player('Mes4', 100); ca uuid := pg_temp.card('Mes enchères marché'); cw uuid := pg_temp.card('Mes gains marché');
  cs uuid := pg_temp.card('Mes ventes marché'); lead uuid := pg_temp.listing(s, ca); outb uuid := pg_temp.listing(s, ca);
  won uuid := pg_temp.listing(s, cw); lost uuid := pg_temp.listing(s, ca); h uuid[]; sell uuid[]; r jsonb; d jsonb; begin
  perform wm.place_bid(p, lead, 10);
  perform wm.place_bid(p, won, 10);
  perform wm.place_bid(p, outb, 10);
  perform wm.place_bid(q, outb, 11);
  perform wm.place_bid(p, lost, 10);
  perform wm.place_bid(q, lost, 11);
  perform wm.place_bid(q, lead, 11);
  perform wm.place_bid(p, lead, 13);
  update public.auctions set end_at = now() - interval '1 minute' where id in (won, lost);
  perform wm.settle_auction(won);
  perform wm.settle_auction(lost);
  h := array(select pg_temp.listing(p, cs) from generate_series(1, 3));
  perform wm.place_bid(b, h[1], 10);
  update public.auctions set end_at = now() - interval '1 minute' where id in (h[1], h[2]);
  perform wm.settle_auction(h[1]);
  perform wm.settle_auction(h[2]);
  perform wm.cancel_auction(p, h[3]);
  sell := array(select pg_temp.listing(p, cs) from generate_series(1, 2));
  r := wm.market_mine_lists(p);
  assert r - array['selling', 'bidding', 'won', 'history'] = '{"mine":true,"counts":{"selling":2,"bidding":4,"won":1,"history":3},
    "wonHasMore":false,"historyHasMore":false,"sellingCount":2,"maxConcurrentAuctions":5}', (r - array['selling', 'bidding', 'won', 'history'])::text;
  assert pg_temp.ids(r -> 'bidding') = array[lead, lost, outb, won], 'ordre de bidding';
  assert (select jsonb_agg(jsonb_build_array(e -> 'my_state', e -> 'my_last_bid', e -> 'owned') order by o)
          from jsonb_array_elements(r -> 'bidding') with ordinality x (e, o))
    = '[["leading", 13, false], ["lost", 10, false], ["outbid", 10, false], ["won", 10, true]]', r -> 'bidding' #>> '{}';
  assert r -> 'bidding' -> 0 = wm.auction_json((select a from public.auctions a where id = lead))
    || '{"owned":false,"my_last_bid":13,"my_state":"leading"}', r -> 'bidding' ->> 0;
  assert pg_temp.ids(r -> 'selling') = array(select i from unnest(sell) i order by i), 'selling';
  assert pg_temp.ids(r -> 'won') = array[won] and r -> 'won' -> 0 = wm.auction_json((select a from public.auctions a where id = won))
    || '{"owned":true}', r -> 'won' #>> '{}';
  assert pg_temp.ids(r -> 'history') = array[h[2], h[1], h[3]], 'ordre de history';
  assert (select array_agg(e ->> 'status' order by o) from jsonb_array_elements(r -> 'history') with ordinality x (e, o))
    = array['settled_unsold', 'settled_sold', 'cancelled'], 'statuts de history';
  assert (select bool_and(e -> 'owned' = 'true') from jsonb_array_elements((r -> 'selling') || (r -> 'history')) e), 'owned des ventes';
  d := pg_temp.err(format('select wm.market_mine_lists(%L, 0)', p));
  assert d = '{"status":400,"code":"invalid_request","error":"La page commence à 1","message":"La page commence à 1"}', coalesce(d::text, 'page 0');
  perform pg_temp.inv('mes enchères');
end $$;

-- won : tout l'historique, settled_at desc, 50 par page. 51 enchères settled_sold gagnées par W, insérées à la main (lignes directes, sans
-- séquestre ni grand livre : hors des invariants, qui ne lisent que les enchères active et le grand livre) ; leur vendeur a 51 lignes
-- d'historique, donc historyHasMore.
do $$ declare w uuid := pg_temp.player('Gains1'); s uuid := pg_temp.player('Gains2'); c uuid := pg_temp.card('Gains marché'); r jsonb;
  prices text := 'select jsonb_agg(e -> ''final_price'' order by o) from jsonb_array_elements(%L::jsonb) with ordinality x (e, o)';
  v jsonb; begin
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, base_amount, listing_base_amount, current_bid,
    current_bidder_id, bids_count, final_price, status, end_at, settled_at, winner_id)
  select s, c, gen_random_uuid(), 'R', 1, 1, i, w, 1, i, 'settled_sold', now() - make_interval(mins => i), now() - make_interval(mins => i), w
  from generate_series(1, 51) i;
  r := wm.market_mine_lists(w);
  execute format(prices, r -> 'won') into v;
  assert v = (select jsonb_agg(i order by i) from generate_series(1, 50) i) and r -> 'wonHasMore' = 'true'
    and r -> 'counts' = '{"selling":0,"bidding":0,"won":51,"history":0}', (r - 'won')::text;
  r := wm.market_mine_lists(w, 2);
  execute format(prices, r -> 'won') into v;
  assert v = '[51]' and r -> 'wonHasMore' = 'false', (r - 'won')::text;
  r := wm.market_mine_lists(s);
  assert jsonb_array_length(r -> 'history') = 50 and r -> 'historyHasMore' = 'true' and r -> 'counts' ->> 'history' = '51', (r - 'history')::text;
  r := wm.market_mine_lists(s, 2);
  execute format(prices, r -> 'history') into v;
  assert v = '[51]' and r -> 'historyHasMore' = 'false', (r - 'history')::text;
  perform pg_temp.inv('gagnées insérées à la main');
end $$;

-- market_mine : ventes actives du joueur (l'échue non réglée comprise, la retirée non) avec user_card_id ; plafond 5 en gratuit, 10 en Pro.
do $$ declare f uuid := pg_temp.player('Quota1'); p uuid := pg_temp.player('Quota2', 0, true); c uuid := pg_temp.card('Quota marché');
  x uuid := pg_temp.listing(f, c); y uuid := pg_temp.listing(f, c); z uuid := pg_temp.listing(f, c); r jsonb; begin
  update public.auctions set end_at = now() - interval '1 minute' where id = y;
  perform wm.cancel_auction(f, z);
  r := wm.market_mine(f);
  assert r = jsonb_build_object('sellingCount', 2, 'maxConcurrentAuctions', 5, 'auctions', (select jsonb_agg(jsonb_build_object('id', id,
    'card_id', card_id, 'user_card_id', user_card_id) order by id) from public.auctions where id in (x, y) and user_card_id is not null)), r::text;
  assert wm.market_mine(p) = '{"sellingCount":0,"maxConcurrentAuctions":10,"auctions":[]}', wm.market_mine(p)::text;
end $$;

-- auction_detail : 52 mises insérées à la main sur une enchère sans meneur (ni meneur ni grand livre : hors des invariants) → les 50 plus
-- récentes, plus récente d'abord, created_at = placed_at, pseudo du miseur ; enchère non échue, donc non réglée.
do $$ declare s uuid := pg_temp.player('Detail1'); m uuid := pg_temp.player('Detail2'); n uuid := pg_temp.player('Detail3');
  x uuid := pg_temp.listing(s, pg_temp.card('Détail marché')); r jsonb; begin
  insert into public.auction_bids (auction_id, bidder_id, amount, placed_at)
  select x, case when i % 2 = 0 then m else n end, 100 - i, now() - make_interval(secs => i) from generate_series(1, 52) i;
  r := wm.auction_detail(x);
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['auction', 'bids'], r::text;
  assert r -> 'auction' = wm.auction_json((select a from public.auctions a where id = x)) and r -> 'auction' ->> 'status' = 'active',
    r ->> 'auction';
  assert r -> 'bids' = (select jsonb_agg(jsonb_build_object('amount', 100 - i, 'placed_at', now() - make_interval(secs => i),
      'created_at', now() - make_interval(secs => i), 'bidder', jsonb_build_object('username', case when i % 2 = 0 then 'Detail2' else 'Detail3' end))
      order by i) from generate_series(1, 50) i), r -> 'bids' ->> 0;
  perform pg_temp.inv('détail');
end $$;

-- Review Focus, règlement sans clic : B mène à 10 sur une enchère échue → auction_detail la règle d'abord (settle_auction) : la réponse est
-- déjà settled_sold, la copie est chez B et le vendeur crédité, sans cron ni /settle ; un second détail ne règle rien de plus. Échue sans
-- mise → settled_unsold, encore lisible. Inconnue ou retirée → 404.
do $$ declare s uuid := pg_temp.player('Paresseux1'); b uuid := pg_temp.player('Paresseux2', 100); c uuid := pg_temp.card('Paresseux marché');
  x uuid := pg_temp.listing(s, c); y uuid := pg_temp.listing(s, c); z uuid := pg_temp.listing(s, c); r jsonb; d jsonb; begin
  perform wm.place_bid(b, x, 10);
  update public.auctions set end_at = now() - interval '1 minute' where id in (x, z);
  r := wm.auction_detail(x);
  assert r -> 'auction' = wm.auction_json((select a from public.auctions a where id = x)) and r -> 'auction' ->> 'status' = 'settled_sold'
    and r -> 'auction' ->> 'winner_id' = b::text and r -> 'auction' -> 'final_price' = '10', r::text;
  assert r -> 'bids' = (select jsonb_build_array(jsonb_build_object('amount', 10, 'placed_at', placed_at, 'created_at', placed_at,
    'bidder', '{"username":"Paresseux2"}'::jsonb)) from public.auction_bids where auction_id = x), r ->> 'bids';
  assert (select count(*) from public.user_cards where user_id = b and card_id = c) = 1, 'copie pas chez le gagnant';
  assert (select jsonb_agg(jsonb_build_array(user_id, delta)) from wm.wb_ledger where ref = 'settle:' || x) = jsonb_build_array(jsonb_build_array(s, 10))
    and (select wikibidous_balance from public.profiles where id = s) = 10, 'vendeur non crédité';
  assert wm.auction_detail(x) = r and (select count(*) from wm.wb_ledger where ref = 'settle:' || x) = 1, 'second détail';
  assert wm.auction_detail(z) -> 'auction' ->> 'status' = 'settled_unsold', 'échue sans mise';
  perform pg_temp.inv('règlement paresseux');
  d := pg_temp.err(format('select wm.auction_detail(%L)', gen_random_uuid()));
  assert d = '{"status":404,"error":"Enchère introuvable","message":"Enchère introuvable"}', coalesce(d::text, 'inconnue acceptée');
  perform wm.cancel_auction(s, y);
  assert pg_temp.err(format('select wm.auction_detail(%L)', y)) = d, 'retirée acceptée';
end $$;

-- card_sales_summary : ventes réelles de la carte, R à 10 puis 11, UR à 7 (copie en UR figée avant la vente) ; une invendue, une retirée et
-- une vente d'une autre carte ne comptent pas. Moyenne arrondie (10,5 → 11). Fenêtre à 1 : la dernière vente de chaque rareté. Carte sans
-- vente → {} ; inconnue → 404.
do $$ declare s uuid := pg_temp.player('Resume1', 0, true); b uuid := pg_temp.player('Resume2', 100); c uuid := pg_temp.card('Résumé marché');
  o uuid := pg_temp.card('Résumé autre marché'); k public.user_cards := wm.grant_copy(s, c, false); x uuid[]; i uuid; d jsonb; begin
  update public.user_cards set snapshot_rarity = 'UR' where id = k.id;
  x := array[pg_temp.listing(s, c, 10), pg_temp.listing(s, c, 11), pg_temp.listing(s, o, 30),
    (wm.create_auction(s, k.id, 7, 60) ->> 'auction_id')::uuid, pg_temp.listing(s, c), pg_temp.listing(s, c)];
  perform wm.place_bid(b, x[1], 10);
  perform wm.place_bid(b, x[2], 11);
  perform wm.place_bid(b, x[3], 30);
  perform wm.place_bid(b, x[4], 7);
  perform wm.cancel_auction(s, x[6]);
  update public.auctions set end_at = now() - interval '1 minute' where id = any (x[1:5]);
  foreach i in array x[1:5] loop  -- dans l'ordre : la vente à 11 est la dernière des R
    perform wm.settle_auction(i);
  end loop;
  assert wm.card_sales_summary(c) = '{"summary":{"R":{"average":11,"count":2},"UR":{"average":7,"count":1}}}', wm.card_sales_summary(c)::text;
  begin
    update wm.config set value = '1' where key = 'sales_summary_window';
    d := wm.card_sales_summary(c);
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d = '{"summary":{"R":{"average":11,"count":1},"UR":{"average":7,"count":1}}}', d::text;
  assert wm.card_sales_summary(pg_temp.card('Résumé vide marché')) = '{"summary":{}}', 'carte sans vente';
  d := pg_temp.err(format('select wm.card_sales_summary(%L)', gen_random_uuid()));
  assert d = '{"status":404,"error":"Carte introuvable","message":"Carte introuvable"}', coalesce(d::text, 'carte inconnue acceptée');
  perform pg_temp.inv('résumé des ventes');
end $$;

-- card_sales : Pro d'abord (403 pro_required, même sur une carte inconnue), puis carte (404). 25 ventes des 25 derniers jours, une de 31 jours
-- et une invendue, insérées à la main (hors des invariants) → sales = les 25, plus récente d'abord, clés exactes ; recent = les 20 premières ;
-- VIP vaut Pro ; max_rows à 3 → 3 lignes.
do $$ declare f uuid := pg_temp.player('Ventes1'); p uuid := pg_temp.player('Ventes2', 0, true); s uuid := pg_temp.player('Ventes3');
  c uuid := pg_temp.card('Ventes marché'); q text := 'select wm.card_sales(%L, %L)'; r jsonb; d jsonb; begin
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, is_shiny, base_amount, listing_base_amount, current_bid,
    bids_count, final_price, status, end_at, settled_at)
  select s, c, gen_random_uuid(), case when i % 2 = 0 then 'SR' else 'R' end::public.rarity, i % 3 = 0, 1, 1, i, 1, i,
    case when i = 27 then 'settled_unsold' else 'settled_sold' end::public.auction_status, now() - make_interval(days => i),
    now() - make_interval(days => case when i = 26 then 31 else i end)
  from generate_series(1, 27) i;
  d := pg_temp.err(format(q, f, c));
  assert d = '{"status":403,"code":"pro_required","error":"Fonction réservée aux membres Pro","message":"Fonction réservée aux membres Pro"}',
    coalesce(d::text, 'non Pro accepté');
  assert pg_temp.err(format(q, f, gen_random_uuid())) = d, 'carte inconnue avant le Pro';
  d := pg_temp.err(format(q, p, gen_random_uuid()));
  assert d = '{"status":404,"error":"Carte introuvable","message":"Carte introuvable"}', coalesce(d::text, 'carte inconnue acceptée');
  r := wm.card_sales(p, c);
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['recent', 'sales'], r::text;
  assert r -> 'sales' = (select jsonb_agg(jsonb_build_object('id', id, 'rarity', snapshot_rarity, 'is_shiny', is_shiny, 'final_price', final_price,
    'settled_at', settled_at) order by final_price) from public.auctions where card_id = c and final_price <= 25), r ->> 'sales';
  assert r -> 'recent' = jsonb_path_query_array(r -> 'sales', '$[0 to 19]') and jsonb_array_length(r -> 'recent') = 20, r ->> 'recent';
  update public.profiles set is_vip = true where id = f;
  assert wm.card_sales(f, c) = r, 'VIP refusé';
  begin
    update wm.config set value = '{"days": 30, "max_rows": 3}' where key = 'sales_detail_window';
    d := wm.card_sales(p, c);
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d -> 'sales' = jsonb_path_query_array(r -> 'sales', '$[0 to 2]') and d -> 'recent' = d -> 'sales', d::text;
  perform pg_temp.inv('ventes Pro');
end $$;

-- Volatilité des lectures (1640) : un create or replace sans le mot-clé repasserait en volatile, et les lectures perdraient leur instantané.
do $$ begin
  assert (select jsonb_object_agg(proname, provolatile::text) from pg_proc where pronamespace = 'wm'::regnamespace
    and proname in ('market_list', 'market_mine_lists', 'market_mine', 'auction_detail'))
    = '{"market_list":"s","market_mine_lists":"s","market_mine":"s","auction_detail":"v"}', 'volatilité des lectures';
end $$;

-- Alertes de liste de souhaits (1650, M3-20, P28).
-- La file des blocs précédents (cartes que personne ne souhaite) est vidée d'abord. Carte souhaitée par trois joueurs et par le vendeur, le
-- plus grand des quatre id (sans le filtre du vendeur, il serait servi au second lot), base 15 : budget de 2 → les deux plus petits id,
-- curseur sur le 2e, ligne en attente ; budget null → rien ; puis le 3e, ligne terminée ; puis rien. Trois wishlist_listed, aucune pour
-- le vendeur, amount 15 et end_at de l'enchère.
do $$ declare p uuid[] := array(select pg_temp.player('Souhait' || i) from generate_series(1, 4) i order by 1); s uuid := p[4];
  w uuid[] := p[1:3]; c uuid := pg_temp.card('Souhait marché'); x uuid; k wm.wishlist_alert_queue; begin
  perform wm.wishlist_alerts_fanout(1000000);
  insert into public.wishlist_items (user_id, card_id) select u, c from unnest(p) u;
  x := pg_temp.listing(s, c, 15);
  assert wm.wishlist_alerts_fanout(2) = 2, 'premier lot';
  select * into k from wm.wishlist_alert_queue where auction_id = x;
  assert k.cursor_user = w[2] and k.done_at is null, to_jsonb(k)::text;
  assert wm.wishlist_alerts_fanout(null) = 0, 'budget nul sans borne';
  assert wm.wishlist_alerts_fanout(2) = 1, 'second lot';
  select * into k from wm.wishlist_alert_queue where auction_id = x;
  assert k.cursor_user = w[3] and k.done_at = now(), to_jsonb(k)::text;
  assert wm.wishlist_alerts_fanout() = 0, 'file vide';
  assert (select array_agg(user_id order by user_id) from public.notifications where type = 'wishlist_listed'
    and data ->> 'auction_id' = x::text) = w, 'destinataires';
  assert (select bool_and(n.data -> 'amount' = '15' and (n.data ->> 'end_at')::timestamptz = a.end_at)
    from public.notifications n join public.auctions a on a.id = x where n.data ->> 'auction_id' = x::text), 'data';
  perform pg_temp.inv('alertes');
end $$;

-- Enchère retirée avant la diffusion → terminée sans notification. Deux lignes de trois souhaits et un budget de 4 sur tout l'appel → 4 (la
-- première entière, le plus petit id de la seconde), puis 2.
do $$ declare s uuid := pg_temp.player('Souhait5'); c uuid := pg_temp.card('Souhait retiré marché'); d uuid := pg_temp.card('Souhait lot marché');
  w uuid[]; y uuid; x1 uuid; x2 uuid; st text := 'select jsonb_agg(jsonb_build_array(cursor_user, done_at is not null) order by id)
    from wm.wishlist_alert_queue where auction_id = any (%L::uuid[])'; v jsonb; begin
  w := array(select pg_temp.player('Souhait' || i) from generate_series(6, 8) i order by 1);
  insert into public.wishlist_items (user_id, card_id) select u, k from unnest(w) u, unnest(array[c, d]) k;
  y := pg_temp.listing(s, c);
  perform wm.cancel_auction(s, y);
  x1 := pg_temp.listing(s, d);
  x2 := pg_temp.listing(s, d);
  assert wm.wishlist_alerts_fanout(4) = 4, 'budget de 4';
  execute format(st, array[y, x1, x2]) into v;
  assert v = jsonb_build_array(jsonb_build_array(null::uuid, true), jsonb_build_array(w[3], true), jsonb_build_array(w[1], false)), v::text;
  assert wm.wishlist_alerts_fanout(4) = 2, 'reste';
  execute format(st, array[x2]) into v;
  assert v = jsonb_build_array(jsonb_build_array(w[3], true)), v::text;
  assert not exists (select from public.notifications where data ->> 'auction_id' = y::text), 'notification d''une enchère retirée';
  assert (select count(*) from public.notifications where type = 'wishlist_listed' and data ->> 'auction_id' in (x1::text, x2::text)) = 6,
    'six notifications';
end $$;

-- Enchère active sans séquestre (cas d'erreur de P9, signalé par les invariants) : sautée sans erreur, l'enchère saine de la même carte est
-- servie, la cassée reste en attente ; séquestre réinséré, elle est servie à l'appel suivant.
do $$ declare s uuid := pg_temp.player('Souhait9'); u uuid := pg_temp.player('Souhait10'); c uuid := pg_temp.card('Souhait cassé marché');
  x uuid := pg_temp.listing(s, c); y uuid := pg_temp.listing(s, c); e wm.auction_escrow; n int; begin
  insert into public.wishlist_items (user_id, card_id) values (u, c);
  delete from wm.auction_escrow where auction_id = x returning * into e;
  assert wm.wishlist_alerts_fanout() = 1, 'diffusion avec une enchère sans séquestre';
  assert (select array_agg(data ->> 'auction_id') from public.notifications where user_id = u) = array[y::text], 'enchère saine non servie';
  assert (select cursor_user is null and done_at is null from wm.wishlist_alert_queue where auction_id = x), 'enchère cassée terminée';
  insert into wm.auction_escrow select (e).*;
  n := wm.wishlist_alerts_fanout();  -- instruction à part : un assert lirait la file avant l'écriture de l'appel
  assert n = 1 and (select done_at = now() from wm.wishlist_alert_queue where auction_id = x), 'après réparation : ' || n;
  perform pg_temp.inv('séquestre réinséré');
end $$;

-- purge_expired (M3-20) : clé d'idempotence de 25 h supprimée, de 23 h gardée ; ligne de file terminée il y a 2 h supprimée, il y a 30 min
-- gardée, en attente gardée. Toutes les autres clés et lignes de file datent de cette transaction.
do $$ declare u uuid := gen_random_uuid(); x uuid := (select auction_id from wm.wishlist_alert_queue limit 1); q bigint[]; r jsonb; begin
  insert into wm.idempotency_keys (user_id, key, created_at)
  values (u, 'vieille', now() - interval '25 hours'), (u, 'récente', now() - interval '23 hours');
  with i as (insert into wm.wishlist_alert_queue (auction_id, done_at)
    values (x, now() - interval '2 hours'), (x, now() - interval '30 minutes'), (x, null) returning id)
  select array_agg(id order by id) into q from i;
  r := wm.purge_expired();
  assert r = '{"idempotency_keys":1,"wishlist_alert_queue":1}', r::text;
  assert (select array_agg(key) from wm.idempotency_keys where user_id = u) = array['récente'], 'clés restantes';
  assert (select array_agg(id order by id) from wm.wishlist_alert_queue where id = any (q)) = q[2:3], 'lignes de file restantes';
end $$;

-- Santé (M3-21, P13) et cron (P12), dans cet ordre ; le rollback du banc défait tout, faux schéma cron compris.
-- Échues des blocs précédents réglées d'abord (elles fausseraient overdue_s). Sans pg_cron : les deux clés sont le JSON null.
do $$ declare h jsonb; begin
  perform wm.settle_due_auctions(100000);
  h := wm.health();
  assert h -> 'settle_lag_s' = 'null'::jsonb and h -> 'overdue_s' = 'null'::jsonb, h::text;
end $$;

-- 9000 sans pg_cron préchargé : sans erreur ni schéma cron.
\ir ../migrations/9000_wm_cron.sql

-- Faux pg_cron 1.6 (colonnes de cron.job et cron.job_run_details lues par 1650). Sans wm-settle → null ; wm-settle sans run → 86400 ; dernier
-- run succeeded de wm-settle fini il y a 5 s → 5 (ni le run en échec ni celui d'un autre job ne comptent). overdue_s : échue depuis 2 min →
-- ≥ 120, depuis 30 s → null. Purge : fini il y a 25 h et sans end_time commencé il y a 25 h → 2, celui d'il y a 23 h reste. Colonne
-- renommée, puis schéma cron sans droit → pas d'exception, 86400 et overdue_s null même avec une échue de 2 min.
do $$ declare s uuid := pg_temp.player('Sante1'); x uuid := pg_temp.listing(s, pg_temp.card('Santé marché')); h jsonb; begin
  assert to_regnamespace('cron') is null, 'schéma cron créé sans pg_cron';
  assert wm.purge_cron_history() = 0, 'purge sans pg_cron';
  create schema cron;
  create table cron.job (jobid bigint, jobname text, schedule text, command text, active boolean);
  create table cron.job_run_details (jobid bigint, runid bigint, status text, start_time timestamptz, end_time timestamptz);
  update public.auctions set end_at = now() - interval '2 minutes' where id = x;
  insert into cron.job values (1, 'wm-purge', '7 * * * *', 'select wm.purge_expired()', true);
  h := wm.health();
  assert h -> 'settle_lag_s' = 'null'::jsonb and h -> 'overdue_s' = 'null'::jsonb, 'sans wm-settle : ' || h::text;
  insert into cron.job values (2, 'wm-settle', '10 seconds', 'select wm.settle_due_auctions(500)', true);
  h := wm.health();
  assert h -> 'settle_lag_s' = '86400' and (h ->> 'overdue_s')::int >= 120, 'wm-settle sans run : ' || h::text;
  insert into cron.job_run_details values
    (2, 1, 'succeeded', now() - interval '6 seconds', now() - interval '5 seconds'),
    (2, 2, 'failed', now() - interval '2 seconds', now() - interval '1 second'),
    (1, 3, 'succeeded', now() - interval '2 seconds', now() - interval '1 second');
  h := wm.health();
  assert h -> 'settle_lag_s' = '5' and (h ->> 'overdue_s')::int >= 120, h::text;
  update public.auctions set end_at = now() - interval '30 seconds' where id = x;
  h := wm.health();
  assert h -> 'settle_lag_s' = '5' and h -> 'overdue_s' = 'null'::jsonb, 'échue depuis 30 s : ' || h::text;
  insert into cron.job_run_details values
    (2, 4, 'succeeded', now() - interval '25 hours 1 second', now() - interval '25 hours'),
    (2, 5, 'failed', now() - interval '25 hours', null),
    (2, 6, 'succeeded', now() - interval '23 hours 1 second', now() - interval '23 hours');
  assert wm.purge_cron_history() = 2, 'purge de l''historique';
  assert (select array_agg(runid order by runid) from cron.job_run_details) = array[1, 2, 3, 6]::bigint[], 'runs restants';
  update public.auctions set end_at = now() - interval '2 minutes' where id = x;
  alter table cron.job rename column jobname to name;
  h := wm.health();
  assert h - 'now' = '{"ok":true,"db":"ok","settle_lag_s":86400,"overdue_s":null}', 'lecture en erreur : ' || h::text;
  -- Droit manquant sur le schéma cron : to_regclass lève 42501 lui-même. Propriétaire sans droit sur cron (défait par le rollback du banc).
  alter table cron.job rename column name to jobname;
  assert wm.health() -> 'settle_lag_s' = '5', 'colonne rétablie';
  alter function wm.health() owner to authenticated;
  h := wm.health();
  assert h - 'now' = '{"ok":true,"db":"ok","settle_lag_s":86400,"overdue_s":null}', 'schéma cron sans droit : ' || h::text;
end $$;
