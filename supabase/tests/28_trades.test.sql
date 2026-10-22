-- Échanges (1700_wm_trade_core.sql, puis 1710…1740) : config, index, verrou d'échange (card_id, P3), objet Trade, notifications, invariant.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ses cartes, et ne filtre que sur eux ;
-- les échéances se posent par rapport à clock_timestamp().

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
create function pg_temp.card(p_title text, p_rarity public.rarity default 'R') returns uuid language sql as $$
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, 1200, 800, 'Catégorie échange')
  returning id
$$;

-- Joueur vérifié (fenêtres anti-bot remises à zéro).
create function pg_temp.player(p_name text, p_balance int default 0) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  return u;
end $$;

-- Une ligne user_cards aux snapshots de la carte.
create function pg_temp.copy(p_uid uuid, p_card uuid, p_count int default 1) returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, count, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select p_uid, id, p_count, wikipedia_title, rarity, category, atk, def from public.cards where id = p_card
  returning id
$$;

create function pg_temp.friends(p_a uuid, p_b uuid) returns void language sql as $$
  insert into public.friendships (requester_id, addressee_id, status) values (p_a, p_b, 'accepted')
$$;

-- Échange posé à la main jusqu'à la Task 4 : un élément par copie, offert par son propriétaire, aux snapshots de la copie.
create function pg_temp.trade(p_from uuid, p_to uuid, p_copies uuid[], p_status public.trade_status default 'pending',
  p_expires interval default '168 hours') returns uuid language plpgsql as $$
declare t uuid; begin
  insert into public.trades (status, initiator_id, recipient_id, expires_at) values (p_status, p_from, p_to, clock_timestamp() + p_expires)
  returning id into t;
  insert into public.trade_items (trade_id, offered_by, user_card_id, card_id, snapshot_rarity, is_shiny)
  select t, uc.user_id, uc.id, uc.card_id, uc.snapshot_rarity, uc.is_shiny
  from unnest(p_copies) with ordinality x (id, o) join public.user_cards uc on uc.id = x.id order by x.o;
  return t;
end $$;

-- Config des échanges (M4-11, P9), chaque clé avec sa note.
do $$ begin
  assert (select jsonb_object_agg(key, value) from wm.config where key in ('trade_limits', 'friend_limit', 'list_caps'))
    = '{"trade_limits":{"cards":100,"wb":10000,"expiry_h":168},"friend_limit":null,
    "list_caps":{"trades_closed":200,"notifications":50,"friend_search":20}}'::jsonb, 'config des échanges';
  assert not exists (select from wm.config where key in ('trade_limits', 'friend_limit', 'list_caps') and coalesce(note, '') = ''),
    'note manquante';
end $$;

-- Index du D:810 et de la recherche de pseudo (M4-11), définition complète.
do $$ declare bad text; begin
  select string_agg(v.n, ', ') into bad from (values
    ('trades_initiator_idx', 'public.trades USING btree (initiator_id, status, created_at DESC)'),
    ('trades_recipient_idx', 'public.trades USING btree (recipient_id, status, created_at DESC)'),
    ('trades_pending_expiry_idx', 'public.trades USING btree (expires_at) WHERE (status = ''pending''::trade_status)'),
    ('trades_parent_idx', 'public.trades USING btree (parent_trade_id) WHERE (parent_trade_id IS NOT NULL)'),
    ('trade_items_trade_idx', 'public.trade_items USING btree (trade_id)'),
    ('trade_items_offered_idx', 'public.trade_items USING btree (offered_by, card_id)'),
    ('friendships_requester_idx', 'public.friendships USING btree (requester_id)'),
    ('friendships_addressee_idx', 'public.friendships USING btree (addressee_id)'),
    ('profiles_username_prefix_idx', 'public.profiles USING btree (lower(username) text_pattern_ops)')) v (n, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef = format('CREATE INDEX %s ON %s', v.n, v.def));
  assert bad is null, 'index absents ou différents : ' || bad;
end $$;

-- lock_timeout de 2 s (P5, M4-2) avant le premier verrou (for update, lock_users, lock_user) ; chaque tâche ajoute ses fonctions.
do $$ declare fs text[] := array['create_auction', 'bulk_discard', 'friend_request', 'friend_action', 'friend_remove', 'friend_accept_all',
  'create_trade', 'trade_action', 'expire_trades'];
  bad text; begin
  select string_agg(f, ', ') into bad from unnest(fs) f, lateral (select prosrc s from pg_proc where oid = to_regproc('wm.' || f)) p,
    lateral (select strpos(s, 'perform set_config(''lock_timeout'', ''2s'', true);') t,
      (select min(i) from unnest(array[strpos(s, 'for update'), strpos(s, 'wm.lock_users('), strpos(s, 'wm.lock_user(')]) i where i > 0) l) x
  where not coalesce(t > 0 and t < l, false);
  assert bad is null, 'lock_timeout absent ou posé après un verrou : ' || bad;
  assert (select count(*) from unnest(fs) f where to_regproc('wm.' || f) is not null) = cardinality(fs), 'fonction absente';
  -- Ligne métier avant les profils (M4-2, C4) : le parent d'une contre-offre est pris avant wm.lock_users.
  assert (select strpos(prosrc, 'for update') between 1 and strpos(prosrc, 'wm.lock_users(') from pg_proc where oid = to_regproc('wm.create_trade')),
    'create_trade : premier for update absent ou après wm.lock_users';
  -- Et l'échange avant les profils dans trade_action.
  assert (select strpos(prosrc, 'for update') between 1 and strpos(prosrc, 'wm.lock_users(') from pg_proc where oid = to_regproc('wm.trade_action')),
    'trade_action : premier for update absent ou après wm.lock_users';
end $$;

-- card_locked (M4-2, P3) : A offre une copie de X et demande à B une copie de Y ; les deux côtés sont verrouillés, au niveau card_id.
-- pendingTradeCardIds : card_id et copies de mes éléments en attente, triés ; jamais ceux d'un autre.
do $$ declare a uuid := pg_temp.player('Verrou1'); b uuid := pg_temp.player('Verrou2');
  x uuid := pg_temp.card('Verrou X'); y uuid := pg_temp.card('Verrou Y'); ka uuid := pg_temp.copy(a, x); t uuid; begin
  perform pg_temp.friends(a, b);
  t := pg_temp.trade(a, b, array[ka, pg_temp.copy(b, y)]);
  assert wm.card_locked(a, x) and wm.card_locked(b, y), 'un côté non verrouillé';
  assert not wm.card_locked(b, x) and not wm.card_locked(a, y), 'verrou chez l''autre joueur';
  assert wm.my_collection(a) -> 'pendingTradeCardIds' = (select jsonb_agg(v order by v) from unnest(array[x::text, ka::text]) v),
    wm.my_collection(a) ->> 'pendingTradeCardIds';
  assert wm.my_collection(b, p_owned_by => a) -> 'pendingTradeCardIds' = '[]', 'échanges d''un autre exposés';
  update public.trades set status = 'declined' where id = t;
  assert not wm.card_locked(a, x) and not wm.card_locked(b, y), 'échange refusé encore verrouillé';
  assert wm.my_collection(a) -> 'pendingTradeCardIds' = '[]', 'échange refusé dans pendingTradeCardIds';
  perform pg_temp.trade(a, b, array[ka], p_expires => interval '-1 second');
  assert not wm.card_locked(a, x), 'échange échu encore verrouillé';
  assert wm.my_collection(a) -> 'pendingTradeCardIds' = '[]', 'échange échu dans pendingTradeCardIds';
end $$;

-- create_auction (M4-10) : copie verrouillée, autre copie de la même carte (par id de copie ou id catalogue) → 409 ; copie d'un autre
-- d'une carte verrouillée pour moi → 403 d'abord ; copie libre → mise en vente.
do $$ declare a uuid := pg_temp.player('Vente1'); b uuid := pg_temp.player('Vente2');
  x uuid := pg_temp.card('Vente X'); y uuid := pg_temp.card('Vente Y'); z uuid := pg_temp.card('Vente Z');
  ka uuid := pg_temp.copy(a, x); kb uuid := pg_temp.copy(b, y); kbx uuid := pg_temp.copy(b, x); q text := 'select wm.create_auction(%L, %L, 10, 60)'; r jsonb;
  d jsonb := '{"status":409,"error":"Cette carte est déjà engagée dans un échange en attente","message":"Cette carte est déjà engagée dans un échange en attente"}';
  begin
  perform pg_temp.friends(a, b);
  perform pg_temp.trade(a, b, array[ka, kb]);
  assert pg_temp.err(format(q, a, ka)) = d, coalesce(pg_temp.err(format(q, a, ka))::text, 'accepté');
  assert pg_temp.err(format(q, a, pg_temp.copy(a, x))) = d, 'seconde copie libre de X';
  assert pg_temp.err(format(q, a, x)) = d, 'id catalogue de X';
  assert pg_temp.err(format(q, a, kbx)) = '{"status":403,"code":"42501","error":"Vous ne possédez pas cette carte","message":"Vous ne possédez pas cette carte"}',
    'copie d''un autre, carte X verrouillée pour moi';
  r := wm.create_auction(a, pg_temp.copy(a, z), 10, 60);
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = '{auction_id,end_at,id}', r::text;
  assert (select count(*) from public.auctions where seller_id = a) = 1, 'une seule vente';
end $$;

-- bulk_discard (M4-10, P25) : chaque id de failed dans l'ordre reçu (copie d'un autre avant la copie verrouillée), avec le message du verrou
-- si la copie est à moi, sinon 403 ; le reste passe ; la copie verrouillée garde son count.
do $$ declare a uuid := pg_temp.player('Defausse1'); b uuid := pg_temp.player('Defausse2');
  ka uuid := pg_temp.copy(a, pg_temp.card('Défausse X'), 2); kw uuid := pg_temp.copy(a, pg_temp.card('Défausse W'));
  kb uuid := pg_temp.copy(b, pg_temp.card('Défausse Y')); r jsonb; begin
  perform pg_temp.trade(a, b, array[ka]);
  r := wm.bulk_discard(a, array[kb, kw, ka]);
  assert r = jsonb_build_object('discarded_count', 1, 'failed', jsonb_build_array(
    jsonb_build_object('id', kb, 'reason', 'Vous ne possédez pas cette carte'),
    jsonb_build_object('id', ka, 'reason', 'Cette carte est déjà engagée dans un échange en attente'))), r::text;
  assert (select count from public.user_cards where id = ka) = 2, 'copie verrouillée entamée';
  assert not exists (select from public.user_cards where id = kw), 'copie libre restée';
  assert (select wikibidous_balance from public.profiles where id = a) = 1, 'gain de défausse';
  perform pg_temp.inv('bulk_discard');
end $$;

-- discard : copie verrouillée → 409 sans code, copie d'un autre → 403 ; échange en attente échu (P3) → la défausse passe.
do $$ declare a uuid := pg_temp.player('Defausse3'); b uuid := pg_temp.player('Defausse4');
  ka uuid := pg_temp.copy(a, pg_temp.card('Défausse V')); kb uuid := pg_temp.copy(b, pg_temp.card('Défausse U'));
  ke uuid := pg_temp.copy(a, pg_temp.card('Défausse T')); q text := 'select wm.discard(%L, %L)'; begin
  perform pg_temp.trade(a, b, array[ka]);
  perform pg_temp.trade(a, b, array[ke], p_expires => interval '-1 second');
  assert pg_temp.err(format(q, a, ka)) = '{"status":409,"error":"Cette carte est déjà engagée dans un échange en attente","message":"Cette carte est déjà engagée dans un échange en attente"}',
    coalesce(pg_temp.err(format(q, a, ka))::text, 'accepté');
  assert pg_temp.err(format(q, a, kb)) = '{"status":403,"code":"42501","error":"Vous ne possédez pas cette carte","message":"Vous ne possédez pas cette carte"}',
    'copie d''un autre';
  assert wm.discard(a, ke) = '{"balance":1}', 'échange échu bloque la défausse';
  assert exists (select from public.user_cards where id = ka), 'copie verrouillée défaussée';
  perform pg_temp.inv('discard');
end $$;

-- trade_json (P7) : 13 colonnes + initiator, recipient, items, counter_trade_id ; éléments à six clés, carte à quatre ; ceux de l'initiateur
-- d'abord, puis rareté desc ; status lu expired pour une ligne pending échue (P3).
do $$ declare a uuid := pg_temp.player('Objet1'); b uuid := pg_temp.player('Objet2');
  kb uuid := pg_temp.copy(b, pg_temp.card('Objet B', 'L')); kc uuid := pg_temp.copy(a, pg_temp.card('Objet C', 'C'));
  ku uuid := pg_temp.copy(a, pg_temp.card('Objet U', 'UR')); t uuid; c uuid; j jsonb; begin
  t := pg_temp.trade(a, b, array[kb, kc, ku]);
  j := (select wm.trade_json(x) from public.trades x where id = t);
  assert (select array_agg(k order by k collate "C") from jsonb_object_keys(j) k) = '{accepted_at,closed_at,completed_at,counter_trade_id,
    created_at,expires_at,id,initiator,initiator_id,initiator_wikibidous,items,parent_trade_id,recipient,recipient_id,recipient_wikibidous,
    status,updated_at}', (select string_agg(k, ',') from jsonb_object_keys(j) k);
  assert j -> 'initiator' = jsonb_build_object('id', a, 'username', 'Objet1') and j -> 'recipient' = jsonb_build_object('id', b, 'username', 'Objet2'),
    'participants';
  assert j ->> 'status' = 'pending' and j -> 'counter_trade_id' = 'null', j::text;
  assert (select bool_and((select array_agg(k order by k collate "C") from jsonb_object_keys(i) k)
            = '{card,card_id,is_shiny,offered_by,snapshot_rarity,user_card_id}'
          and (select array_agg(k order by k collate "C") from jsonb_object_keys(i -> 'card') k) = '{id,image_url,rarity,wikipedia_title}')
          from jsonb_array_elements(j -> 'items') i), j ->> 'items';
  assert jsonb_path_query_array(j -> 'items', '$[*].user_card_id') = jsonb_build_array(ku, kc, kb), j ->> 'items';
  assert j -> 'items' -> 0 = jsonb_build_object('offered_by', a, 'card_id', (select card_id from public.user_cards where id = ku), 'user_card_id', ku,
    'snapshot_rarity', 'UR', 'is_shiny', false, 'card', (select jsonb_build_object('id', id, 'wikipedia_title', wikipedia_title,
    'image_url', image_url, 'rarity', rarity) from public.cards where wikipedia_title = 'Objet U')), j -> 'items' ->> 0;
  -- Lien enfant : la contre-offre dont t est le parent.
  insert into public.trades (initiator_id, recipient_id, parent_trade_id, expires_at) values (b, a, t, clock_timestamp() + interval '1 hour')
  returning id into c;
  assert (select wm.trade_json(x) -> 'counter_trade_id' from public.trades x where id = t) = to_jsonb(c), 'counter_trade_id';
  update public.trades set expires_at = clock_timestamp() - interval '1 second' where id = t;
  assert (select wm.trade_json(x) ->> 'status' from public.trades x where id = t) = 'expired', 'échange échu lu pending';
end $$;

-- notify_trade (P6, P28) : une ligne par id non nul, data = {trade_id, user_id, username} de l'auteur.
do $$ declare a uuid := pg_temp.player('Notif1'); b uuid := pg_temp.player('Notif2'); t uuid := pg_temp.trade(a, b, '{}'); begin
  assert wm.notify_trade(array[b, null], 'trade_received', t, a) = 1, 'nombre de lignes';
  assert (select array_agg(data) from public.notifications where user_id = b and type = 'trade_received')
    = array[jsonb_build_object('trade_id', t, 'user_id', a, 'username', 'Notif1')], 'data';
  assert not exists (select from public.notifications where user_id = a), 'auteur notifié';
end $$;

-- Invariant trade_money (P8) : Σ delta d'une référence trade:<id> nulle.
do $$ declare a uuid := pg_temp.player('Argent1'); b uuid := pg_temp.player('Argent2', 10); t uuid := pg_temp.trade(a, b, '{}'); begin
  perform wm.wallet_apply(a, 5, 'trade', 'trade:' || t);
  assert wm.check_invariants() = jsonb_build_array(jsonb_build_object('check', 'trade_money', 'ref', 'trade:' || t, 'sum', 5)),
    wm.check_invariants()::text;
  perform wm.wallet_apply(b, -5, 'trade', 'trade:' || t);
  perform pg_temp.inv('trade_money');
end $$;

-- Amitiés (1710, M4-11, M4-12, P4, P6).
-- friend_request : demande en attente, friendship_json, notification pour le destinataire ; doublon dans un sens ou dans l'autre → 409
-- REQUEST_PENDING sans acceptation implicite ; soi-même → 400 ; inconnu → 404 ; même clé → même réponse, une ligne, une notification.
do $$ declare a uuid := pg_temp.player('AmiA1'); b uuid := pg_temp.player('AmiB1'); c uuid := pg_temp.player('AmiC1'); r jsonb; f uuid;
  q text := 'select wm.friend_request(%L, %L)';
  d jsonb := '{"status":409,"code":"REQUEST_PENDING","error":"Une demande d''ami est déjà en attente","message":"Une demande d''ami est déjà en attente"}';
  begin
  r := wm.friend_request(a, b);
  f := (r #>> '{friendship,id}')::uuid;
  assert r -> 'friendship' = (select to_jsonb(x) from public.friendships x where id = f) || jsonb_build_object(
    'requester', jsonb_build_object('id', a, 'username', 'AmiA1', 'avatar_url', null),
    'addressee', jsonb_build_object('id', b, 'username', 'AmiB1', 'avatar_url', null)), r::text;
  assert r #>> '{friendship,status}' = 'pending' and r #>> '{friendship,requester_id}' = a::text, r::text;
  assert (select array_agg(data) from public.notifications where user_id = b and type = 'friend_request')
    = array[jsonb_build_object('friendship_id', f, 'user_id', a, 'username', 'AmiA1')], 'notification de demande';
  assert not exists (select from public.notifications where user_id = a), 'demandeur notifié';
  assert pg_temp.err(format(q, a, b)) = d, coalesce(pg_temp.err(format(q, a, b))::text, 'accepté');
  assert pg_temp.err(format(q, b, a)) = d, 'demande croisée';
  assert (select status from public.friendships where id = f) = 'pending', 'acceptation implicite';
  assert pg_temp.err(format(q, a, a)) = '{"status":400,"code":"invalid_request","error":"Tu ne peux pas t''ajouter toi-même en ami","message":"Tu ne peux pas t''ajouter toi-même en ami"}',
    'soi-même';
  assert pg_temp.err(format(q, a, gen_random_uuid())) = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}', 'inconnu';
  r := wm.friend_request(a, c, 'k-req');
  assert wm.friend_request(a, c, 'k-req') = r, 'rejeu';
  assert (select count(*) from public.friendships where addressee_id = c) = 1 and (select count(*) from public.notifications where user_id = c) = 1,
    'effet rejoué';
end $$;

-- friend_action : seul le destinataire accepte ou refuse ; acceptation → friendship_json et notification pour le demandeur ; amis → 409 ;
-- étranger → 404 ; action inconnue → 400. Refus (M4-11) : la ligne disparaît, sans notification, le rejeu rend la réponse stockée, et une
-- nouvelle demande passe.
do $$ declare a uuid := pg_temp.player('AmiA2'); b uuid := pg_temp.player('AmiB2'); carol uuid := pg_temp.player('AmiCarol2');
  c uuid := pg_temp.player('AmiC2'); d uuid := pg_temp.player('AmiD2'); f uuid; g uuid; r jsonb; q text := 'select wm.friend_action(%L, %L, %L)';
  af jsonb := '{"status":409,"code":"ALREADY_FRIENDS","error":"Vous êtes déjà amis","message":"Vous êtes déjà amis"}';
  nf jsonb := '{"status":404,"error":"Demande d''ami introuvable","message":"Demande d''ami introuvable"}';
  begin
  f := (wm.friend_request(a, b) #>> '{friendship,id}')::uuid;
  assert pg_temp.err(format(q, a, f, 'accept')) = '{"status":403,"code":"FORBIDDEN","error":"Seul le destinataire peut accepter cette demande","message":"Seul le destinataire peut accepter cette demande"}',
    coalesce(pg_temp.err(format(q, a, f, 'accept'))::text, 'accepté');
  assert pg_temp.err(format(q, a, f, 'decline')) = '{"status":403,"code":"FORBIDDEN","error":"Seul le destinataire peut refuser cette demande","message":"Seul le destinataire peut refuser cette demande"}',
    coalesce(pg_temp.err(format(q, a, f, 'decline'))::text, 'refusé');
  assert pg_temp.err(format(q, carol, f, 'accept')) = nf and pg_temp.err(format(q, b, gen_random_uuid(), 'accept')) = nf, 'étranger ou inconnue';
  assert pg_temp.err(format(q, b, f, 'xyz')) = '{"status":400,"code":"invalid_request","error":"Action inconnue","message":"Action inconnue"}', 'xyz';
  r := wm.friend_action(b, f, 'accept', 'k-acc');
  assert r = jsonb_build_object('friendship', (select wm.friendship_json(x) from public.friendships x where id = f))
    and r #>> '{friendship,status}' = 'accepted', r::text;
  assert wm.friend_action(b, f, 'accept', 'k-acc') = r, 'acceptation rejouée';
  assert (select array_agg(data) from public.notifications where user_id = a and type = 'friend_accepted')
    = array[jsonb_build_object('friendship_id', f, 'user_id', b, 'username', 'AmiB2')], 'notification d''acceptation';
  assert wm.are_friends(a, b) and wm.are_friends(b, a) and not wm.are_friends(a, carol), 'are_friends';
  assert pg_temp.err(format(q, b, f, 'accept')) = af, 'acceptée deux fois';
  assert pg_temp.err(format('select wm.friend_request(%L, %L)', a, b)) = af, 'demande entre amis';
  g := (wm.friend_request(c, d) #>> '{friendship,id}')::uuid;
  assert not wm.are_friends(c, d), 'demande en attente vue comme amitié';
  assert wm.friend_action(d, g, 'decline', 'k-dec') = '{"ok":true}', 'refus';
  assert wm.friend_action(d, g, 'decline', 'k-dec') = '{"ok":true}', 'refus rejoué';
  assert not exists (select from public.friendships where id = g), 'demande refusée encore là';
  assert not exists (select from public.notifications where user_id = c), 'refus notifié';
  assert wm.friend_request(c, d) #>> '{friendship,status}' = 'pending', 'nouvelle demande après un refus';
end $$;

-- friends_list : toutes mes lignes (amis, demandes envoyées et reçues), created_at desc puis id ; jamais celles des autres.
do $$ declare a uuid := pg_temp.player('Liste1'); b uuid := pg_temp.player('Liste2'); c uuid := pg_temp.player('Liste3');
  d uuid := pg_temp.player('Liste4'); begin
  perform pg_temp.friends(a, b);
  perform wm.friend_request(a, c);
  perform wm.friend_request(d, a);
  perform wm.friend_request(b, c);
  update public.friendships set created_at = now() - interval '1 day' where requester_id = d and addressee_id = a;
  assert wm.friends_list(a) = jsonb_build_object('friendships', (select jsonb_agg(wm.friendship_json(f) order by f.created_at desc, f.id)
    from public.friendships f where a in (f.requester_id, f.addressee_id))), wm.friends_list(a)::text;
  assert jsonb_path_query_array(wm.friends_list(a) -> 'friendships', '$[*].requester.username') -> -1 = '"Liste4"', 'ordre created_at desc';
  assert jsonb_array_length(wm.friends_list(a) -> 'friendships') = 3, 'lignes d''un autre';
end $$;

-- Limite (M4-11), friend_limit à 1 : demande, acceptation (les deux joueurs) et tout accepter (le lot entier) → 409, rien ne change.
do $$ declare a uuid := pg_temp.player('Limite1'); b uuid := pg_temp.player('Limite2'); e uuid := pg_temp.player('Limite3');
  g uuid := pg_temp.player('Limite4'); h uuid := pg_temp.player('Limite5'); k uuid := pg_temp.player('Limite6'); f uuid; fb uuid;
  d jsonb := '{"status":409,"code":"FRIEND_LIMIT","error":"Limite d''amis atteinte (1)","message":"Limite d''amis atteinte (1)"}';
  begin
  perform pg_temp.friends(a, b);
  fb := (wm.friend_request(b, e) #>> '{friendship,id}')::uuid;
  update wm.config set value = '1' where key = 'friend_limit';
  assert pg_temp.err(format('select wm.friend_request(%L, %L)', a, e)) = d,
    coalesce(pg_temp.err(format('select wm.friend_request(%L, %L)', a, e))::text, 'accepté');
  f := (wm.friend_request(g, a) #>> '{friendship,id}')::uuid;
  perform wm.friend_request(h, a);
  assert pg_temp.err(format('select wm.friend_action(%L, %L, ''accept'')', a, f)) = d, 'acceptation au-delà de la limite';
  assert pg_temp.err(format('select wm.friend_accept_all(%L)', a)) = d, 'tout accepter au-delà de la limite';
  assert (select array_agg(status::text) from public.friendships where addressee_id = a) = '{pending,pending}', 'demandes acceptées';
  -- Le demandeur est à sa limite.
  assert pg_temp.err(format('select wm.friend_action(%L, %L, ''accept'')', e, fb)) = d, 'demandeur à sa limite';
  assert pg_temp.err(format('select wm.friend_accept_all(%L)', e)) = d, 'tout accepter, demandeur à sa limite';
  -- Le lot entier compte : 0 ami et deux demandes pour une limite de 1.
  perform wm.friend_request(g, k);
  perform wm.friend_request(h, k);
  assert pg_temp.err(format('select wm.friend_accept_all(%L)', k)) = d, 'lot entier';
  assert not exists (select from public.friendships where status = 'accepted' and (addressee_id in (a, e, k))), 'acceptation passée';
  update wm.config set value = 'null'::jsonb where key = 'friend_limit';
  assert wm.friend_action(a, f, 'accept') #>> '{friendship,status}' = 'accepted', 'limite désactivée';
end $$;

-- friend_accept_all : toutes mes demandes reçues en attente, une notification par demandeur ; ma demande envoyée reste en attente ;
-- rejeu → même réponse ; sans clé et sans demande → 0.
do $$ declare c uuid := pg_temp.player('Tout1'); d uuid := pg_temp.player('Tout2'); e uuid := pg_temp.player('Tout3');
  f uuid := pg_temp.player('Tout4'); g uuid := pg_temp.player('Tout5'); begin
  perform wm.friend_request(x, f) from unnest(array[c, d, e]) x;
  perform wm.friend_request(f, g);
  assert wm.friend_accept_all(f, 'k-all') = '{"accepted":3}', 'tout accepter';
  assert (select array_agg(data order by user_id) from public.notifications where type = 'friend_accepted' and user_id in (c, d, e, g))
    = (select array_agg(jsonb_build_object('friendship_id', id, 'user_id', f, 'username', 'Tout4') order by requester_id)
       from public.friendships where addressee_id = f), 'notifications';
  assert (select array_agg(status::text) from public.friendships where addressee_id = f) = '{accepted,accepted,accepted}', 'statuts';
  assert (select status from public.friendships where requester_id = f) = 'pending', 'demande envoyée acceptée';
  assert wm.friend_accept_all(f, 'k-all') = '{"accepted":3}', 'rejeu';
  assert wm.friend_accept_all(f) = '{"accepted":0}', 'sans demande';
end $$;

-- friend_remove (Review Focus) : les échanges en attente entre les deux, dans les deux sens, passent à cancelled ; l'accepté, l'échu et
-- celui d'un tiers restent ; cartes libérées ; amitié supprimée ; aucune notification ; rejeu → réponse stockée ; étranger → 404. Une
-- demande en attente se retire des deux côtés.
do $$ declare a uuid := pg_temp.player('Retrait1'); b uuid := pg_temp.player('Retrait2'); carol uuid := pg_temp.player('Retrait3');
  c uuid := pg_temp.player('Retrait4'); d uuid := pg_temp.player('Retrait5'); x uuid := pg_temp.card('Retrait X'); y uuid := pg_temp.card('Retrait Y');
  f uuid; g uuid; t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid; s jsonb; begin
  perform pg_temp.friends(a, b);
  f := (select id from public.friendships where requester_id = a and addressee_id = b);
  t1 := pg_temp.trade(a, b, array[pg_temp.copy(a, x)]);
  t2 := pg_temp.trade(b, a, array[pg_temp.copy(b, y)]);
  t3 := pg_temp.trade(a, b, array[pg_temp.copy(a, pg_temp.card('Retrait Z'))], 'accepted');
  t4 := pg_temp.trade(b, a, array[pg_temp.copy(b, pg_temp.card('Retrait W'))], p_expires => interval '-1 second');
  t5 := pg_temp.trade(a, carol, array[pg_temp.copy(a, pg_temp.card('Retrait V'))]);
  assert pg_temp.err(format('select wm.friend_remove(%L, %L)', carol, f)) = '{"status":404,"error":"Demande d''ami introuvable","message":"Demande d''ami introuvable"}',
    coalesce(pg_temp.err(format('select wm.friend_remove(%L, %L)', carol, f))::text, 'retiré');
  assert wm.friend_remove(b, f, 'k-rm') = '{"ok":true}', 'retrait';
  -- [statut, closed_at posé, updated_at après la création] ; created_at et updated_at valent now() à l'insertion.
  s := (select jsonb_object_agg(id, jsonb_build_array(status, closed_at is not null, updated_at > created_at)) from public.trades
    where id in (t1, t2, t3, t4, t5));
  assert s = jsonb_build_object(t1, '["cancelled",true,true]'::jsonb, t2, '["cancelled",true,true]'::jsonb,
    t3, '["accepted",false,false]'::jsonb, t4, '["pending",false,false]'::jsonb, t5, '["pending",false,false]'::jsonb), s::text;
  assert (select wm.trade_json(t) ->> 'status' from public.trades t where id = t4) = 'expired', 'échu lu pending';
  assert not wm.card_locked(a, x) and not wm.card_locked(b, y), 'cartes encore verrouillées';
  assert not exists (select from public.friendships where id = f), 'amitié encore là';
  assert not exists (select from public.notifications where user_id in (a, b)), 'retrait notifié';
  assert wm.friend_remove(b, f, 'k-rm') = '{"ok":true}', 'rejeu';
  g := (wm.friend_request(c, d) #>> '{friendship,id}')::uuid;
  assert wm.friend_remove(c, g) = '{"ok":true}', 'retrait par l''auteur';
  assert not exists (select from public.friendships where id = g), 'demande retirée par son auteur';
  g := (wm.friend_request(c, d) #>> '{friendship,id}')::uuid;
  assert wm.friend_remove(d, g) = '{"ok":true}', 'retrait par le destinataire';
  assert not exists (select from public.friendships where id = g), 'demande retirée par son destinataire';
end $$;

-- Maintenance : 503 avant tout verrou, même pour une amitié inconnue.
do $$ declare a uuid := pg_temp.player('AmiMaint1');
  d jsonb := '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.","message":"Maintenance en cours, reviens dans quelques minutes."}';
  begin
  update wm.config set value = 'true' where key = 'maintenance';
  assert pg_temp.err(format('select wm.friend_remove(%L, %L)', a, gen_random_uuid())) = d, 'friend_remove';
  assert pg_temp.err(format('select wm.friend_accept_all(%L)', a)) = d, 'friend_accept_all';
  update wm.config set value = 'false' where key = 'maintenance';
end $$;

-- friend_search (P12) : préfixe sans casse ni espaces autour, % et _ littéraux, ordre lower(username), 20 lignes, soi-même exclu ;
-- moins de 2 caractères → 400 ; l'index de préfixe sert le motif.
do $$ declare s uuid := pg_temp.player('zz_0'); j jsonb; q text := 'select wm.friend_search(%L, %L)';
  d jsonb := '{"status":400,"code":"invalid_request","error":"La recherche demande au moins 2 caractères","message":"La recherche demande au moins 2 caractères"}';
  begin
  perform pg_temp.player(n) from unnest(array['ZetaAlpha', 'zetabeta', 'Zeta_1', 'Zetab2']) n;
  perform pg_temp.player('zz_' || i) from generate_series(1, 24) i;
  j := wm.friend_search(s, 'ZETA');
  assert jsonb_path_query_array(j -> 'users', '$[*].username') = '["Zeta_1","ZetaAlpha","Zetab2","zetabeta"]', j::text;
  assert j -> 'users' -> 0 = (select jsonb_build_object('id', id, 'username', 'Zeta_1', 'avatar_url', null) from public.profiles
    where username = 'Zeta_1'), j ->> 'users';
  assert jsonb_path_query_array(wm.friend_search(s, 'zeta_') -> 'users', '$[*].username') = '["Zeta_1"]', '_ littéral';
  assert wm.friend_search(s, 'z%') = '{"users":[]}', '% littéral';
  -- Antislash échappé d'abord : à l'envers, « zw\_ » deviendrait zw\\\\_% (deux antislashs puis un caractère quelconque) et ne trouverait rien.
  -- Pseudos hérités, jamais revérifiés (C28) : l'inscription refuse l'antislash, pas la base.
  perform pg_temp.player(n) from unnest(array['zw_1', 'zwa2']) n;
  update public.profiles set username = 'zw\' || substr(username, 3) where username in ('zw_1', 'zwa2');
  assert jsonb_path_query_array(wm.friend_search(s, 'zw\') -> 'users', '$[*].username') = '["zw\\_1","zw\\a2"]', '\ littéral';
  assert jsonb_path_query_array(wm.friend_search(s, 'zw\_') -> 'users', '$[*].username') = '["zw\\_1"]', '\ puis _ littéraux';
  j := wm.friend_search(s, 'zz') -> 'users';
  assert jsonb_array_length(j) = 20 and not jsonb_path_exists(j, '$[*] ? (@.id == $s)', jsonb_build_object('s', s)), j::text;
  assert pg_temp.err(format(q, s, 'z')) = d and pg_temp.err(format(q, s, '  z ')) = d, 'moins de 2 caractères';
  set local enable_seqscan = off;
  execute 'explain (format json) select id from public.profiles where lower(username) like ''ze%''' into j;
  reset enable_seqscan;
  assert strpos(j::text, '"profiles_username_prefix_idx"') > 0, j::text;
end $$;

-- Collection des amis (S:36) : owned_by d'un ami au profil privé et wishlisted_by d'un ami passent ; une demande en attente n'ouvre rien.
do $$ declare a uuid := pg_temp.player('AmiColl1'); b uuid := pg_temp.player('AmiColl2'); carol uuid := pg_temp.player('AmiColl3');
  x uuid := pg_temp.card('Amis X'); r jsonb; begin
  update public.profiles set is_public = false where id = a;
  perform pg_temp.friends(b, a);
  perform wm.friend_request(carol, a);
  perform pg_temp.copy(a, x);
  perform pg_temp.copy(b, x);
  insert into public.wishlist_items (user_id, card_id) values (a, x);
  r := wm.my_collection(b, p_owned_by => a);
  assert r -> 'total' = '1' and r #>> '{collection,0,user_id}' = a::text, r::text;
  assert pg_temp.err(format('select wm.my_collection(%L, p_owned_by => %L)', carol, a))
    = '{"status":403,"code":"FORBIDDEN","error":"Cette collection est privée","message":"Cette collection est privée"}', 'collection privée';
  r := wm.my_collection(b, p_wishlisted_by => a);
  assert r -> 'total' = '1' and r #>> '{collection,0,user_id}' = b::text, r::text;
  assert pg_temp.err(format('select wm.my_collection(%L, p_wishlisted_by => %L)', carol, a))
    = '{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour voir sa liste de souhaits","message":"Vous devez être amis pour voir sa liste de souhaits"}',
    'souhaits d''un non-ami';
end $$;

-- Volatilité (M3-R5) : un create or replace sans le mot-clé repasserait en volatile.
do $$ begin
  assert (select jsonb_object_agg(proname, provolatile::text) from pg_proc where pronamespace = 'wm'::regnamespace
    and proname in ('are_friends', 'friendship_json', 'friends_list', 'friend_search'))
    = '{"are_friends":"s","friendship_json":"s","friends_list":"s","friend_search":"s"}', 'volatilité des lectures d''amitié';
end $$;

-- Création d'un échange (1720, M4-2, M4-9, M4-12, P2).
-- p_items de create_trade : un élément par entrée de p_copies (répétée pour plusieurs unités), offert par p_by, au card_id de la copie.
create function pg_temp.items(p_by uuid, p_copies uuid[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_card_id', x, 'card_id', (select card_id from public.user_cards where id = x),
    'offered_by', p_by) order by o), '[]')
  from unnest(p_copies) with ordinality u (x, o)
$$;

-- Réponse = trade_json : pending, éléments de l'initiateur d'abord malgré l'ordre d'envoi, card_id pris sur la copie et non sur le client
-- (P2) ; échéance à 168 h ; une trade_received pour le destinataire ; ni grand livre ni solde touchés ; carte offerte verrouillée.
do $$ declare a uuid := pg_temp.player('Creation1', 500); b uuid := pg_temp.player('Creation2'); x uuid := pg_temp.card('Création X');
  a1 uuid := pg_temp.copy(a, pg_temp.card('Création A1', 'UR')); a2 uuid := pg_temp.copy(a, x, 3);
  b1 uuid := pg_temp.copy(b, pg_temp.card('Création B1')); t0 timestamptz; t1 timestamptz; r jsonb; begin
  perform pg_temp.friends(a, b);
  t0 := clock_timestamp();
  r := wm.create_trade(a, b, pg_temp.items(b, array[b1]) || jsonb_build_array(jsonb_build_object('user_card_id', a1, 'card_id', x,
    'offered_by', a)) || pg_temp.items(a, array[a2, a2]), 300, 0);
  t1 := clock_timestamp();
  assert r = (select wm.trade_json(t) from public.trades t where id = (r ->> 'id')::uuid), r::text;
  assert r ->> 'status' = 'pending' and r -> 'initiator_wikibidous' = '300' and r -> 'recipient_wikibidous' = '0'
    and r -> 'parent_trade_id' = 'null', r::text;
  assert jsonb_path_query_array(r -> 'items', '$[*].user_card_id') = jsonb_build_array(a1, a2, a2, b1)
    and jsonb_path_query_array(r -> 'items', '$[*].offered_by') = jsonb_build_array(a, a, a, b), r ->> 'items';
  assert r #> '{items,0,card_id}' = (select to_jsonb(card_id) from public.user_cards where id = a1), 'card_id du client (P2)';
  assert (r ->> 'expires_at')::timestamptz between t0 + interval '168 hours' and t1 + interval '168 hours', r ->> 'expires_at';
  assert (select array_agg(jsonb_build_array(user_id, type, data)) from public.notifications where user_id in (a, b))
    = array[jsonb_build_array(b, 'trade_received', jsonb_build_object('trade_id', r -> 'id', 'user_id', a, 'username', 'Creation1'))],
    'notification';
  assert not exists (select from wm.wb_ledger where user_id in (a, b)), 'grand livre';
  assert (select wikibidous_balance from public.profiles where id = a) = 500 and (select wikibidous_balance from public.profiles where id = b) = 0,
    'soldes';
  assert wm.card_locked(a, x), 'carte offerte non verrouillée';
  perform pg_temp.inv('create_trade');
end $$;

-- Refus aux corps exacts (M4-9). Passent : 100 unités d'une pile de 150 (plus une carte de B, le plafond est par côté), 10 000 WB demandés à
-- un joueur sans rien, WB nuls lus 0, tout le solde offert. La même copie dans plusieurs échanges en attente (M4-2).
do $$ declare a uuid := pg_temp.player('Refus1', 100); b uuid := pg_temp.player('Refus2'); carol uuid := pg_temp.player('Refus3');
  ka uuid := pg_temp.copy(a, pg_temp.card('Refus A')); kp uuid := pg_temp.copy(a, pg_temp.card('Refus P'), 150);
  k2 uuid := pg_temp.copy(a, pg_temp.card('Refus D'), 2); kb uuid := pg_temp.copy(b, pg_temp.card('Refus B'));
  km uuid := pg_temp.copy(a, pg_temp.card('Refus M')); q text := 'select wm.create_trade(%L, %L, %L, %s, %s)'; one jsonb; d jsonb; r jsonb;
  t1 uuid; t2 uuid; begin
  perform pg_temp.friends(a, b);
  one := pg_temp.items(a, array[ka]);
  assert pg_temp.err(format(q, a, carol, one, 0, 0)) = '{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour échanger","message":"Vous devez être amis pour échanger"}',
    coalesce(pg_temp.err(format(q, a, carol, one, 0, 0))::text, 'créé');
  assert pg_temp.err(format(q, a, a, one, 0, 0)) = '{"status":400,"code":"invalid_request","error":"Tu ne peux pas échanger avec toi-même","message":"Tu ne peux pas échanger avec toi-même"}',
    'soi-même';
  assert pg_temp.err(format(q, a, gen_random_uuid(), one, 0, 0)) = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}',
    'inconnu';
  assert pg_temp.err(format(q, a, b, '[]', 10, 10)) = '{"status":400,"code":"invalid_request","error":"Un échange contient au moins une carte","message":"Un échange contient au moins une carte"}',
    'WB seuls';
  assert jsonb_array_length(wm.create_trade(a, b, pg_temp.items(a, array_fill(kp, array[100])) || pg_temp.items(b, array[kb])) -> 'items') = 101,
    '100 unités et une carte de B';
  assert pg_temp.err(format(q, a, b, pg_temp.items(a, array_fill(kp, array[101])), 0, 0)) = '{"status":400,"code":"invalid_request","error":"Au plus 100 cartes par côté","message":"Au plus 100 cartes par côté"}',
    '101 unités';
  d := '{"status":400,"code":"invalid_request","error":"Entre 0 et 10 000 wikibidous par côté","message":"Entre 0 et 10 000 wikibidous par côté"}';
  assert pg_temp.err(format(q, a, b, one, 0, 10001)) = d and pg_temp.err(format(q, a, b, one, 0, -1)) = d
    and pg_temp.err(format(q, a, b, one, 10001, 0)) = d and pg_temp.err(format(q, a, b, one, -1, 0)) = d, 'WB hors bornes';
  assert wm.create_trade(a, b, one, 0, 10000) -> 'recipient_wikibidous' = '10000', '10 000 WB demandés à B';
  r := wm.create_trade(a, b, one, null, null);
  assert r -> 'initiator_wikibidous' = '0' and r -> 'recipient_wikibidous' = '0', 'WB nuls';
  t1 := wm.create_trade(a, b, pg_temp.items(a, array[km])) ->> 'id';
  t2 := wm.create_trade(a, b, pg_temp.items(a, array[km])) ->> 'id';
  assert (select count(*) from public.trades t join public.trade_items i on i.trade_id = t.id
    where t.id in (t1, t2) and t.status = 'pending' and i.user_card_id = km) = 2, 'même copie dans deux échanges en attente';
  d := '{"status":400,"code":"invalid_request","error":"Élément d''échange invalide","message":"Élément d''échange invalide"}';
  assert pg_temp.err(format(q, a, b, one || jsonb_build_array(jsonb_build_object('user_card_id', kb, 'card_id', null, 'offered_by', carol)), 0, 0)) = d,
    'élément de Carol';
  assert pg_temp.err(format(q, a, b, jsonb_build_array(jsonb_build_object('user_card_id', ka, 'offered_by', null)), 0, 0)) = d, 'offered_by null';
  d := '{"status":403,"code":"42501","error":"Vous ne possédez pas cette carte","message":"Vous ne possédez pas cette carte"}';
  assert pg_temp.err(format(q, a, b, pg_temp.items(a, array[k2, k2, k2]), 0, 0)) = d, 'trois unités d''une pile de 2';
  assert pg_temp.err(format(q, a, b, pg_temp.items(a, array[kb]), 0, 0)) = d, 'copie de B offerte par A';
  assert pg_temp.err(format(q, a, b, pg_temp.items(a, array[gen_random_uuid()]), 0, 0)) = d, 'copie inexistante';
  assert pg_temp.err(format(q, a, b, one, 101, 0)) = '{"status":409,"code":"insufficient_balance","error":"Solde insuffisant","message":"Solde insuffisant"}',
    'solde';
  assert wm.create_trade(a, b, one, 100, 0) -> 'initiator_wikibidous' = '100', 'tout le solde';
  assert (select wikibidous_balance from public.profiles where id = a) = 100, 'solde débité à la création';
end $$;

-- Un seul côté (M4-9), acceptés à la Task 5 : A offre a3 seule contre 50 WB, sans élément de B ; A demande b2 seule, B ne demande rien.
do $$ declare a uuid := pg_temp.player('Cote1'); b uuid := pg_temp.player('Cote2');
  a3 uuid := pg_temp.copy(a, pg_temp.card('Côté A3')); b2 uuid := pg_temp.copy(b, pg_temp.card('Côté B2')); r jsonb; begin
  perform pg_temp.friends(a, b);
  r := wm.create_trade(a, b, pg_temp.items(a, array[a3]), 0, 50);
  assert r ->> 'status' = 'pending' and jsonb_path_query_array(r -> 'items', '$[*].user_card_id') = jsonb_build_array(a3)
    and r -> 'recipient_wikibidous' = '50', r::text;
  r := wm.create_trade(a, b, pg_temp.items(b, array[b2]));
  assert r ->> 'status' = 'pending' and jsonb_path_query_array(r -> 'items', '$[*].user_card_id') = jsonb_build_array(b2)
    and r -> 'initiator_wikibidous' = '0' and r -> 'recipient_wikibidous' = '0', r::text;
end $$;

-- Contre-offre (D§7.6, M4-12) : B répond à T1 de A ; T2 pointe vers T1, T1 passe à countered (closed_at) et son counter_trade_id vaut T2 ;
-- une trade_countered pour A, aucune trade_received de plus. Refus : l'initiateur 403, un tiers ou un parent inconnu 404, un autre
-- destinataire 400, un parent clos ou échu (Review Focus) 409.
do $$ declare a uuid := pg_temp.player('Contre1'); b uuid := pg_temp.player('Contre2'); carol uuid := pg_temp.player('Contre3');
  ka uuid := pg_temp.copy(a, pg_temp.card('Contre A')); kb uuid := pg_temp.copy(b, pg_temp.card('Contre B'));
  q text := 'select wm.create_trade(%L, %L, %L, p_parent_trade_id => %L)'; t1 uuid; t2 uuid; t3 uuid; r jsonb;
  nf jsonb := '{"status":404,"error":"Échange introuvable","message":"Échange introuvable"}';
  d jsonb := '{"status":409,"error":"Cet échange n''est plus en attente (déjà traité)","message":"Cet échange n''est plus en attente (déjà traité)"}';
  begin
  perform pg_temp.friends(a, b);
  t1 := wm.create_trade(a, b, pg_temp.items(a, array[ka])) ->> 'id';
  assert pg_temp.err(format(q, a, b, pg_temp.items(b, array[kb]), t1)) = '{"status":403,"code":"FORBIDDEN","error":"Seul le destinataire peut faire une contre-offre","message":"Seul le destinataire peut faire une contre-offre"}',
    coalesce(pg_temp.err(format(q, a, b, pg_temp.items(b, array[kb]), t1))::text, 'créée');
  assert pg_temp.err(format(q, carol, a, pg_temp.items(a, array[ka]), t1)) = nf
    and pg_temp.err(format(q, b, a, pg_temp.items(b, array[kb]), gen_random_uuid())) = nf, 'tiers ou parent inconnu';
  assert pg_temp.err(format(q, b, carol, pg_temp.items(b, array[kb]), t1)) = '{"status":400,"code":"invalid_request","error":"La contre-offre s''adresse à l''initiateur de l''échange","message":"La contre-offre s''adresse à l''initiateur de l''échange"}',
    'autre destinataire';
  r := wm.create_trade(b, a, pg_temp.items(b, array[kb]) || pg_temp.items(a, array[ka]), p_parent_trade_id => t1);
  t2 := r ->> 'id';
  assert r ->> 'status' = 'pending' and r ->> 'initiator_id' = b::text and r ->> 'recipient_id' = a::text
    and r ->> 'parent_trade_id' = t1::text, r::text;
  assert (select status = 'countered' and closed_at is not null and updated_at > created_at from public.trades where id = t1), 'parent';
  assert (select wm.trade_json(t) ->> 'counter_trade_id' from public.trades t where id = t1) = t2::text, 'lien enfant';
  assert (select array_agg(jsonb_build_array(user_id, type, data) order by type) from public.notifications where user_id in (a, b))
    = array[jsonb_build_array(a, 'trade_countered', jsonb_build_object('trade_id', t2, 'user_id', b, 'username', 'Contre2')),
      jsonb_build_array(b, 'trade_received', jsonb_build_object('trade_id', t1, 'user_id', a, 'username', 'Contre1'))], 'notifications';
  assert pg_temp.err(format(q, b, a, pg_temp.items(b, array[kb]), t1)) = d, 'parent déjà countered';
  t3 := wm.create_trade(a, b, pg_temp.items(a, array[ka])) ->> 'id';
  -- Échu entre le début de la transaction et maintenant : une garde sur now() le croirait encore en attente.
  update public.trades set expires_at = now() + (clock_timestamp() - now()) / 2 where id = t3;
  assert pg_temp.err(format(q, b, a, pg_temp.items(b, array[kb]), t3)) = d, 'parent échu';
end $$;

-- Même Idempotency-Key → même réponse, un seul échange, une seule notification ; p_tz reçu sans effet (C30).
do $$ declare a uuid := pg_temp.player('CleEch1'); b uuid := pg_temp.player('CleEch2'); one jsonb; r jsonb; begin
  perform pg_temp.friends(a, b);
  one := pg_temp.items(a, array[pg_temp.copy(a, pg_temp.card('Clé échange'))]);
  r := wm.create_trade(a, b, one, p_tz => 'Europe/Paris', p_idem => 'k-trade');
  assert wm.create_trade(a, b, one, p_tz => 'Europe/Paris', p_idem => 'k-trade') = r, 'rejeu';
  assert (select count(*) from public.trades where initiator_id = a) = 1 and (select count(*) from public.notifications where user_id = b) = 1,
    'effet rejoué';
end $$;

-- Acceptation, refus, annulation, expiration (1730, M4-3, M4-4, M4-5, M4-7, M4-8, M4-9, M4-12, P13, P23, P25).
-- Review Focus, pile et WB : A donne a1 (seule, favorite, deux étiquettes, son avatar) et 2 unités de a2 (pile de 3, favorite, une
-- étiquette, brillante, snapshots et obtained_at distincts de la carte) ; B donne b1 ; WB 300 contre 500. a1 et b1 gardent leur id ; a2 reste
-- chez A avec une unité, son étoile et son étiquette ; B reçoit une ligne neuve de 2 aux snapshots et à l'obtained_at de a2 ; une ligne
-- trade: par joueur, au net ; une trade_accepted pour A.
do $$ declare a uuid := pg_temp.player('Accepte1', 1000); b uuid := pg_temp.player('Accepte2', 1000); x uuid := pg_temp.card('Accepte A2', 'SR');
  a1 uuid := pg_temp.copy(a, pg_temp.card('Accepte A1', 'UR')); a2 uuid := pg_temp.copy(a, x, 3); b1 uuid := pg_temp.copy(b, pg_temp.card('Accepte B1'));
  t uuid; r jsonb; s public.user_cards; n public.user_cards; begin
  perform pg_temp.friends(a, b);
  update public.user_cards set starred = true where id in (a1, a2);
  update public.user_cards set is_shiny = true, obtained_at = now() - interval '3 days', snapshot_title = 'Accepte A2 (ancien)',
    snapshot_rarity = 'UR', snapshot_category = 'Ancienne', snapshot_atk = 1, snapshot_def = 2 where id = a2;
  with tg as (insert into public.tags (user_id, name) values (a, 'un'), (a, 'deux'), (a, 'trois') returning id, name)
  insert into public.user_card_tags (user_card_id, tag_id) select case name when 'trois' then a2 else a1 end, id from tg;
  update public.profiles set avatar_user_card_id = a1 where id = a;
  t := wm.create_trade(a, b, pg_temp.items(a, array[a1, a2, a2]) || pg_temp.items(b, array[b1]), 300, 500) ->> 'id';
  r := wm.trade_action(b, t, 'accept');
  assert r = jsonb_build_object('status', 'accepted', 'trade', (select wm.trade_json(tr) from public.trades tr where id = t)), r::text;
  assert r #>> '{trade,status}' = 'accepted' and r #>> '{trade,accepted_at}' is not null
    and r #> '{trade,accepted_at}' = r #> '{trade,completed_at}' and r #> '{trade,completed_at}' = r #> '{trade,closed_at}'
    and r #> '{trade,updated_at}' = r #> '{trade,closed_at}'
    and (r #>> '{trade,updated_at}')::timestamptz > (r #>> '{trade,created_at}')::timestamptz, r ->> 'trade';
  assert (select row(user_id, count, starred) = row(b, 1, false) from public.user_cards where id = a1)
    and not exists (select from public.user_card_tags where user_card_id = a1), 'a1';
  assert (select avatar_user_card_id from public.profiles where id = a) is null, 'avatar de A';
  select * into s from public.user_cards where id = a2;
  assert row(s.user_id, s.count, s.starred) = row(a, 1, true) and (select count(*) from public.user_card_tags where user_card_id = a2) = 1, 'a2';
  assert (select count(*) from public.user_cards where user_id = b and card_id = x) = 1, 'lignes de B pour la carte de a2';
  select * into n from public.user_cards where user_id = b and card_id = x;
  assert n.id <> a2 and n.count = 2 and not n.starred and not exists (select from public.user_card_tags where user_card_id = n.id)
    and row(n.is_shiny, n.snapshot_title, n.snapshot_rarity, n.snapshot_category, n.snapshot_atk, n.snapshot_def, n.obtained_at)
      = row(s.is_shiny, s.snapshot_title, s.snapshot_rarity, s.snapshot_category, s.snapshot_atk, s.snapshot_def, s.obtained_at), to_jsonb(n)::text;
  assert (select user_id from public.user_cards where id = b1) = a, 'b1';
  assert (select array_agg(jsonb_build_array(user_id, delta, reason) order by delta desc) from wm.wb_ledger where ref = 'trade:' || t)
    = array[jsonb_build_array(a, 200, 'trade'), jsonb_build_array(b, -200, 'trade')], 'grand livre';
  assert (select array_agg(wikibidous_balance order by username) from public.profiles where id in (a, b)) = '{1200,800}', 'soldes';
  assert (select array_agg(jsonb_build_array(user_id, data)) from public.notifications where type = 'trade_accepted' and user_id in (a, b))
    = array[jsonb_build_array(a, jsonb_build_object('trade_id', t, 'user_id', b, 'username', 'Accepte2'))], 'notification';
  perform pg_temp.inv('acceptation');
end $$;

-- WB 100 contre 100 : net nul, aucune ligne trade:, soldes inchangés.
do $$ declare a uuid := pg_temp.player('Egal1', 500); b uuid := pg_temp.player('Egal2', 500); t uuid; begin
  perform pg_temp.friends(a, b);
  t := wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, pg_temp.card('Égal A'))]), 100, 100) ->> 'id';
  assert wm.trade_action(b, t, 'accept') ->> 'status' = 'accepted', 'acceptation';
  assert not exists (select from wm.wb_ledger where ref = 'trade:' || t), 'ligne trade: pour un net nul';
  assert (select array_agg(wikibidous_balance) from public.profiles where id in (a, b)) = '{500,500}', 'soldes';
  perform pg_temp.inv('net nul');
end $$;

-- Un seul côté (M4-9), les deux échanges de la Task 4 : a3 seule contre 50 WB → a3 chez B, A +50, B −50 ; b2 seule demandée par A, sans WB
-- → b2 chez A, sans ligne trade:.
do $$ declare a uuid := pg_temp.player('Seul1'); b uuid := pg_temp.player('Seul2', 100);
  a3 uuid := pg_temp.copy(a, pg_temp.card('Seul A3')); b2 uuid := pg_temp.copy(b, pg_temp.card('Seul B2')); t uuid; begin
  perform pg_temp.friends(a, b);
  t := wm.create_trade(a, b, pg_temp.items(a, array[a3]), 0, 50) ->> 'id';
  assert wm.trade_action(b, t, 'accept') ->> 'status' = 'accepted', 'a3 contre 50 WB';
  assert (select user_id from public.user_cards where id = a3) = b, 'a3';
  assert (select array_agg(jsonb_build_array(user_id, delta) order by delta desc) from wm.wb_ledger where ref = 'trade:' || t)
    = array[jsonb_build_array(a, 50), jsonb_build_array(b, -50)], 'grand livre';
  t := wm.create_trade(a, b, pg_temp.items(b, array[b2])) ->> 'id';
  assert wm.trade_action(b, t, 'accept') ->> 'status' = 'accepted', 'b2 seule';
  assert (select user_id from public.user_cards where id = b2) = a, 'b2';
  assert not exists (select from wm.wb_ledger where ref = 'trade:' || t), 'ligne trade: sans WB';
  perform pg_temp.inv('un seul côté');
end $$;

-- Review Focus, solde net : B à 250 passe (net −200) et finit à 50 ; B à 150 → 409 insufficient_balance et rien ne bouge. Initiateur à
-- court (M4-4) : A vidé après la création → la même 409, rien ne bouge.
do $$ declare a uuid := pg_temp.player('Net1', 1000); b uuid := pg_temp.player('Net2', 250); c uuid := pg_temp.player('Net3', 1000);
  d uuid := pg_temp.player('Net4', 150); e uuid := pg_temp.player('Net5', 1000); f uuid := pg_temp.player('Net6', 1000); t uuid; s jsonb;
  q text := 'select wm.trade_action(%L, %L, ''accept'')';
  bal jsonb := '{"status":409,"code":"insufficient_balance","error":"Solde insuffisant","message":"Solde insuffisant"}'; begin
  perform pg_temp.friends(a, b);
  perform pg_temp.friends(c, d);
  perform pg_temp.friends(e, f);
  t := wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, pg_temp.card('Net A'))]), 300, 500) ->> 'id';
  assert wm.trade_action(b, t, 'accept') ->> 'status' = 'accepted', 'B à 250';
  assert (select wikibidous_balance from public.profiles where id = b) = 50, 'solde de B';
  t := wm.create_trade(c, d, pg_temp.items(c, array[pg_temp.copy(c, pg_temp.card('Net C'))]), 300, 500) ->> 'id';
  s := tests.trade_snapshot(t);
  assert pg_temp.err(format(q, d, t)) = bal, coalesce(pg_temp.err(format(q, d, t))::text, 'accepté');
  assert tests.trade_snapshot(t) = s and s #>> '{trade,status}' = 'pending', tests.trade_snapshot(t)::text;
  t := wm.create_trade(e, f, pg_temp.items(e, array[pg_temp.copy(e, pg_temp.card('Net E'))]), 300) ->> 'id';
  perform wm.wallet_apply(e, -950, 'test', 'test:drain');
  s := tests.trade_snapshot(t);
  assert pg_temp.err(format(q, f, t)) = bal, coalesce(pg_temp.err(format(q, f, t))::text, 'accepté');
  assert tests.trade_snapshot(t) = s, tests.trade_snapshot(t)::text;
  perform pg_temp.inv('solde net');
end $$;

-- Review Focus, copie promise deux fois (M4-2, P25) : a1 dans T1 et T2 vers B, T1 accepté → T2 en 409, pending, inchangé, a1 (chez B,
-- participant) verrouillée. Même chose avec T3 vers C, sans verrouiller a1, désormais chez B : un for update pose l'xid du verrouilleur dans
-- xmax, même annulé ensuite.
do $$ declare a uuid := pg_temp.player('Deux1'); b uuid := pg_temp.player('Deux2'); c uuid := pg_temp.player('Deux3');
  a1 uuid := pg_temp.copy(a, pg_temp.card('Deux A1')); t1 uuid; t2 uuid; t3 uuid; s jsonb; x0 text; q text := 'select wm.trade_action(%L, %L, ''accept'')';
  d jsonb := '{"status":409,"error":"Une carte de cet échange n''est plus disponible","message":"Une carte de cet échange n''est plus disponible"}';
  begin
  perform pg_temp.friends(a, b);
  perform pg_temp.friends(a, c);
  t1 := wm.create_trade(a, b, pg_temp.items(a, array[a1])) ->> 'id';
  t2 := wm.create_trade(a, b, pg_temp.items(a, array[a1])) ->> 'id';
  t3 := wm.create_trade(a, c, pg_temp.items(a, array[a1])) ->> 'id';
  assert wm.trade_action(b, t1, 'accept') ->> 'status' = 'accepted', 'T1';
  s := tests.trade_snapshot(t2);
  x0 := (select xmax::text from public.user_cards where id = a1);
  assert pg_temp.err(format(q, b, t2)) = d, coalesce(pg_temp.err(format(q, b, t2))::text, 'accepté');
  assert (select xmax::text from public.user_cards where id = a1) <> x0, 'copie d''un participant non verrouillée';
  assert tests.trade_snapshot(t2) = s and s #>> '{trade,status}' = 'pending', tests.trade_snapshot(t2)::text;
  s := tests.trade_snapshot(t3);
  x0 := (select xmax::text from public.user_cards where id = a1);
  assert pg_temp.err(format(q, c, t3)) = d, coalesce(pg_temp.err(format(q, c, t3))::text, 'accepté');
  assert (select xmax::text from public.user_cards where id = a1) = x0, 'copie du tiers verrouillée';
  assert tests.trade_snapshot(t3) = s and s #>> '{trade,status}' = 'pending', tests.trade_snapshot(t3)::text;
end $$;

-- Amitié supprimée à la main → 403.
do $$ declare a uuid := pg_temp.player('Ancien1'); b uuid := pg_temp.player('Ancien2'); t uuid; begin
  perform pg_temp.friends(a, b);
  t := wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, pg_temp.card('Ancien A'))])) ->> 'id';
  delete from public.friendships where id = (select id from public.friendships where requester_id = a and addressee_id = b);
  assert pg_temp.err(format('select wm.trade_action(%L, %L, ''accept'')', b, t))
    = '{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour échanger","message":"Vous devez être amis pour échanger"}',
    coalesce(pg_temp.err(format('select wm.trade_action(%L, %L, ''accept'')', b, t))::text, 'accepté');
end $$;

-- Rôles (M4-9) : accepter et refuser au destinataire, annuler à l'initiateur ; un tiers ou un id inconnu → 404 ; une action inconnue → 400,
-- avant la recherche de l'échange. Refus → declined, une trade_declined pour A, carte libérée ; annulation → cancelled, une trade_cancelled
-- pour B.
do $$ declare a uuid := pg_temp.player('Role1'); b uuid := pg_temp.player('Role2'); carol uuid := pg_temp.player('Role3');
  x uuid := pg_temp.card('Rôle X'); t uuid; r jsonb; q text := 'select wm.trade_action(%L, %L, %L)';
  nf jsonb := '{"status":404,"error":"Échange introuvable","message":"Échange introuvable"}';
  u jsonb := '{"status":400,"code":"invalid_request","error":"Action inconnue","message":"Action inconnue"}'; begin
  perform pg_temp.friends(a, b);
  t := wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, x)])) ->> 'id';
  assert pg_temp.err(format(q, a, t, 'accept')) = '{"status":403,"code":"FORBIDDEN","error":"Seul le destinataire peut accepter cet échange","message":"Seul le destinataire peut accepter cet échange"}',
    coalesce(pg_temp.err(format(q, a, t, 'accept'))::text, 'accepté');
  assert pg_temp.err(format(q, a, t, 'decline')) = '{"status":403,"code":"FORBIDDEN","error":"Seul le destinataire peut refuser cet échange","message":"Seul le destinataire peut refuser cet échange"}',
    'refus par l''initiateur';
  assert pg_temp.err(format(q, b, t, 'cancel')) = '{"status":403,"code":"FORBIDDEN","error":"Seul l''initiateur peut annuler cet échange","message":"Seul l''initiateur peut annuler cet échange"}',
    'annulation par le destinataire';
  assert pg_temp.err(format(q, carol, t, 'accept')) = nf and pg_temp.err(format(q, b, gen_random_uuid(), 'accept')) = nf, 'tiers ou inconnu';
  assert pg_temp.err(format(q, b, t, 'counter')) = u and pg_temp.err(format(q, carol, gen_random_uuid(), 'counter')) = u, 'counter';
  r := wm.trade_action(b, t, 'decline');
  assert r = jsonb_build_object('status', 'declined', 'trade', (select wm.trade_json(tr) from public.trades tr where id = t))
    and r #>> '{trade,closed_at}' is not null and (r #>> '{trade,updated_at}')::timestamptz > (r #>> '{trade,created_at}')::timestamptz, r::text;
  assert (select array_agg(jsonb_build_array(user_id, type, data)) from public.notifications where type <> 'trade_received' and user_id in (a, b))
    = array[jsonb_build_array(a, 'trade_declined', jsonb_build_object('trade_id', t, 'user_id', b, 'username', 'Role2'))], 'notification de refus';
  assert not wm.card_locked(a, x), 'carte encore verrouillée';
  t := wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, x)])) ->> 'id';
  r := wm.trade_action(a, t, 'cancel');
  assert r ->> 'status' = 'cancelled' and r #>> '{trade,status}' = 'cancelled' and r #>> '{trade,closed_at}' is not null
    and (r #>> '{trade,updated_at}')::timestamptz > (r #>> '{trade,created_at}')::timestamptz, r::text;
  assert (select array_agg(jsonb_build_array(user_id, data)) from public.notifications where type = 'trade_cancelled' and user_id in (a, b))
    = array[jsonb_build_array(b, jsonb_build_object('trade_id', t, 'user_id', a, 'username', 'Role1'))], 'notification d''annulation';
end $$;

-- Rejeu (M4-8) : accept répété sans clé → 409 « déjà traité » ; avec la clé du succès → la réponse stockée.
do $$ declare a uuid := pg_temp.player('Rejeu1'); b uuid := pg_temp.player('Rejeu2'); t uuid; r jsonb; begin
  perform pg_temp.friends(a, b);
  t := wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, pg_temp.card('Rejeu A'))])) ->> 'id';
  r := wm.trade_action(b, t, 'accept', null, 'k-acc');
  assert pg_temp.err(format('select wm.trade_action(%L, %L, ''accept'')', b, t))
    = '{"status":409,"error":"Cet échange n''est plus en attente (déjà traité)","message":"Cet échange n''est plus en attente (déjà traité)"}',
    coalesce(pg_temp.err(format('select wm.trade_action(%L, %L, ''accept'')', b, t))::text, 'accepté deux fois');
  assert wm.trade_action(b, t, 'accept', null, 'k-acc') = r, 'rejeu à clé';
end $$;

-- Review Focus, échéance (M4-5, P3) : les échus des blocs précédents passés d'abord ; trois pending échus → 409 sur accept, decline et cancel ;
-- en maintenance, expire_trades(2) → 2, puis 1, puis 0 ; seuls ces trois-là passent à expired, avec closed_at ; ni notification ni grand livre.
-- Un échu entre le début de la transaction et maintenant : une garde ou un lot sur now() le croiraient encore en attente.
do $$ declare a uuid := pg_temp.player('Echeance1'); b uuid := pg_temp.player('Echeance2'); t uuid; ts uuid[]; s0 jsonb; nl bigint; nn bigint;
  q text := 'select wm.trade_action(%L, %L, %L)';
  d jsonb := '{"status":409,"error":"Cet échange n''est plus en attente (déjà traité)","message":"Cet échange n''est plus en attente (déjà traité)"}';
  begin
  perform pg_temp.friends(a, b);
  t := wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, pg_temp.card('Échéance 0'))])) ->> 'id';
  update public.trades set expires_at = now() + (clock_timestamp() - now()) / 2 where id = t;
  assert pg_temp.err(format(q, b, t, 'accept')) = d, 'échu après now() accepté';
  perform wm.expire_trades();
  assert (select status from public.trades where id = t) = 'expired', 'échu après now() resté pending';
  ts := array(select (wm.create_trade(a, b, pg_temp.items(a, array[pg_temp.copy(a, pg_temp.card('Échéance ' || i))])) ->> 'id')::uuid
    from generate_series(1, 3) i);
  update public.trades set expires_at = clock_timestamp() - interval '1 second' where id = any (ts);
  assert pg_temp.err(format(q, b, ts[1], 'accept')) = d, coalesce(pg_temp.err(format(q, b, ts[1], 'accept'))::text, 'accepté');
  assert pg_temp.err(format(q, b, ts[2], 'decline')) = d and pg_temp.err(format(q, a, ts[3], 'cancel')) = d, 'refus ou annulation d''un échu';
  s0 := (select jsonb_object_agg(id, status) from public.trades);
  nl := (select count(*) from wm.wb_ledger);
  nn := (select count(*) from public.notifications);
  update wm.config set value = 'true' where key = 'maintenance';
  assert wm.expire_trades(2) = 2, 'premier lot';
  assert wm.expire_trades() = 1, 'second lot';
  assert wm.expire_trades() = 0, 'rien à expirer';
  update wm.config set value = 'false' where key = 'maintenance';
  assert (select jsonb_object_agg(id, status) from public.trades) = s0 || (select jsonb_object_agg(x, 'expired') from unnest(ts) x), 'statuts';
  assert not exists (select from public.trades where id = any (ts) and (closed_at is null or updated_at <= created_at)), 'closed_at ou updated_at';
  assert (select count(*) from wm.wb_ledger) = nl and (select count(*) from public.notifications) = nn, 'argent ou notification';
end $$;

-- 9010 sans pg_cron : sans erreur ni schéma cron. Un mauvais job ne se voit qu'au cron.job de la démo (Task 16 Step 4).
\ir ../migrations/9010_wm_trade_cron.sql
do $$ begin
  assert to_regnamespace('cron') is null, 'schéma cron créé sans pg_cron';
end $$;

-- 100 ↔ 100 fonctionnel (M4-6) : par côté 70 copies seules, 2 unités de 10 piles de 3 et 1 unité de 10 piles de 2, WB 500 et 300. Σ count
-- de chaque joueur inchangé ; chez chacun, 10 lignes neuves de 2 et 10 de 1.
do $$ declare a uuid := pg_temp.player('Cent1', 1000); b uuid := pg_temp.player('Cent2', 1000); u uuid; c uuid; p3 uuid[]; ids uuid[]; sa uuid[]; sb uuid[];
  items jsonb := '[]'; sums jsonb; t uuid; begin
  perform pg_temp.friends(a, b);
  foreach u in array array[a, b] loop
    c := pg_temp.card('Cent ' || u);
    p3 := array(select pg_temp.copy(u, c, 3) from generate_series(1, 10));
    items := items || pg_temp.items(u, array(select pg_temp.copy(u, c) from generate_series(1, 70))
      || array(select k from unnest(p3) k, generate_series(1, 2)) || array(select pg_temp.copy(u, c, 2) from generate_series(1, 10)));
  end loop;
  ids := array(select id from public.user_cards where user_id in (a, b));
  -- Les 70 copies seules de chaque côté (k = n) : les seules lignes de count 1 avant l'échange.
  sa := array(select id from public.user_cards where user_id = a and count = 1);
  sb := array(select id from public.user_cards where user_id = b and count = 1);
  sums := (select jsonb_object_agg(user_id, n) from (select user_id, sum(count) n from public.user_cards where user_id in (a, b) group by 1) z);
  t := wm.create_trade(a, b, items, 500, 300) ->> 'id';
  assert jsonb_array_length(items) = 200, 'éléments';
  assert wm.trade_action(b, t, 'accept') ->> 'status' = 'accepted', 'acceptation';
  assert (select jsonb_object_agg(user_id, n) from (select user_id, sum(count) n from public.user_cards where user_id in (a, b) group by 1) z)
    = sums, 'Σ count';
  foreach u in array array[a, b] loop
    assert (select jsonb_object_agg(count, n) from (select count, count(*) n from public.user_cards where user_id = u and id <> all (ids)
      group by 1) z) = '{"1": 10, "2": 10}', 'lignes neuves';
  end loop;
  assert cardinality(sa) = 70 and cardinality(sb) = 70
    and (select count(*) from public.user_cards where id = any (sa) and user_id = b and count = 1) = 70
    and (select count(*) from public.user_cards where id = any (sb) and user_id = a and count = 1) = 70, 'copies seules non déplacées';
  perform pg_temp.inv('100 ↔ 100');
end $$;

-- Erreur injectée (M4-7 A, P23), après les déplacements (grand livre) puis sur la dernière instruction (notification) : tout est annulé, état
-- complet compris ; sans le trigger, la même clé → accepted, et chaque partie de l'état bouge.
do $$ declare a uuid := pg_temp.player('Faute1', 1000); b uuid := pg_temp.player('Faute2', 1000); a1 uuid; a2 uuid; t uuid; s jsonb; r jsonb;
  tbl text; begin
  perform pg_temp.friends(a, b);
  for n in 1 .. 2 loop
    a1 := pg_temp.copy(a, pg_temp.card('Faute A1 ' || n));
    a2 := pg_temp.copy(a, pg_temp.card('Faute A2 ' || n), 3);
    update public.user_cards set starred = true where id in (a1, a2);
    with tg as (insert into public.tags (user_id, name) values (a, 'Faute ' || n) returning id)
    insert into public.user_card_tags (user_card_id, tag_id) select k, tg.id from tg, unnest(array[a1, a2]) k;
    update public.profiles set avatar_user_card_id = a1 where id = a;
    t := wm.create_trade(a, b, pg_temp.items(a, array[a1, a2, a2]) || pg_temp.items(b, array[pg_temp.copy(b, pg_temp.card('Faute B1 ' || n))]),
      300, 500) ->> 'id';
    s := tests.trade_snapshot(t);
    if n = 1 then
      tbl := 'wm.wb_ledger';
      execute format('create trigger zz_boom after insert on wm.wb_ledger for each row when (new.ref = %L) execute function tests.boom()', 'trade:' || t);
    else
      tbl := 'public.notifications';
      execute format('create trigger zz_boom after insert on public.notifications for each row when (new.data ->> ''trade_id'' = %L) '
        'execute function tests.boom()', t);
    end if;
    begin
      perform wm.trade_action(b, t, 'accept', null, 'k-inj-' || n);
      assert false, 'faute non levée : ' || tbl;
    exception when sqlstate 'XX000' then
      assert sqlerrm = 'erreur injectée', sqlerrm;
    end;
    assert tests.trade_snapshot(t) = s, tbl || ' : ' || tests.trade_snapshot(t)::text;
    execute 'drop trigger zz_boom on ' || tbl;
    assert wm.trade_action(b, t, 'accept', null, 'k-inj-' || n) ->> 'status' = 'accepted', 'même clé sans trigger';
    r := tests.trade_snapshot(t);
    assert s ->> 'ledger' = '0' and r ->> 'ledger' = '2' and s ->> 'notifications' = '1' and r ->> 'notifications' = '2'
      and (r ->> 'idem')::int = (s ->> 'idem')::int + 1 and r #>> '{trade,status}' = 'accepted' and r -> 'copies' <> s -> 'copies'
      and r -> 'tags' <> s -> 'tags' and r -> 'profiles' <> s -> 'profiles' and r -> 'invariants' = '[]', r::text;
  end loop;
end $$;

-- Lectures (1740, M4-16, P3), lignes posées à la main. A : trois pending, dont un échu (lu expired, P3), insérés du plus ancien au plus récent ;
-- 201 clos aux statuts mêlés, insérés du plus ancien clos au plus récent, aux created_at dans l'ordre inverse des closed_at ; B–Carol à côté.
-- Attendu : les pending par création décroissante, puis les 200 clos les plus récents par closed_at ; ni le 201e ni B–Carol.
do $$ declare a uuid := pg_temp.player('ListeEch1'); b uuid := pg_temp.player('ListeEch2'); carol uuid := pg_temp.player('ListeEch3');
  p uuid[]; c uuid[]; r jsonb; begin
  insert into public.trades (initiator_id, recipient_id, created_at, expires_at)
  select case when i = 2 then b else a end, case when i = 2 then a else b end, now() - make_interval(mins => 4 - i),
    clock_timestamp() + case when i = 2 then interval '-1 second' else interval '1 day' end
  from generate_series(1, 3) i order by i;
  insert into public.trades (status, initiator_id, recipient_id, created_at, closed_at, expires_at)
  select (array['accepted', 'declined', 'cancelled', 'expired', 'countered'])[1 + i % 5]::public.trade_status,
    case when i % 2 = 0 then a else b end, case when i % 2 = 0 then b else a end,
    now() - interval '1 day' - make_interval(mins => 202 - i), now() - make_interval(mins => i), now()
  from generate_series(1, 201) i order by i desc;
  insert into public.trades (initiator_id, recipient_id, expires_at) values (b, carol, clock_timestamp() + interval '1 day');
  p := array(select id from public.trades where status = 'pending' and a in (initiator_id, recipient_id) order by created_at desc);
  c := array(select id from public.trades where status <> 'pending' and a in (initiator_id, recipient_id) order by closed_at desc);
  r := wm.trades_list(a);
  assert cardinality(p) = 3 and cardinality(c) = 201 and r = jsonb_build_object('trades', (select jsonb_agg(wm.trade_json(t) order by x.o)
    from unnest(p || c[1:200]) with ordinality x (id, o) join public.trades t on t.id = x.id)), jsonb_path_query_array(r, '$.trades[*].id')::text;
  assert jsonb_path_query_array(r, '$.trades[0 to 2].status') = '["pending","expired","pending"]', jsonb_path_query_array(r, '$.trades[*].status')::text;
end $$;

-- Détail : chaque participant lit {trade} ; Carol ou un id inconnu → 404.
do $$ declare a uuid := pg_temp.player('DetailEch1'); b uuid := pg_temp.player('DetailEch2'); carol uuid := pg_temp.player('DetailEch3');
  t uuid; q text := 'select wm.trade_detail(%L, %L)';
  d jsonb := '{"status":404,"error":"Échange introuvable","message":"Échange introuvable"}'; begin
  insert into public.trades (initiator_id, recipient_id, expires_at) values (a, b, clock_timestamp() + interval '1 day') returning id into t;
  assert wm.trade_detail(a, t) = jsonb_build_object('trade', (select wm.trade_json(tr) from public.trades tr where id = t))
    and wm.trade_detail(b, t) = wm.trade_detail(a, t), wm.trade_detail(a, t)::text;
  assert pg_temp.err(format(q, carol, t)) = d, coalesce(pg_temp.err(format(q, carol, t))::text, 'lu par Carol');
  assert pg_temp.err(format(q, a, gen_random_uuid())) = d, 'id inconnu';
end $$;

-- Notifications (M4-13, M4-16, P10) : 55 pour A, une par seconde, insérées de la plus ancienne à la plus récente, dont une auction_outbid au
-- data du M3 ; 3 pour B. Liste : les 50 plus récentes de A, dans l'ordre, chacune exactement {id, type, data, read, created_at}. Marquage :
-- les ids de B ignorés, '{}' ne lit rien, null lit tout le reste ; rejeu à clé ; maintenance. Cloche : la requête de PostgREST, sous la RLS
-- de A, passe par l'index partiel (PG réécrit read = false en NOT read, son prédicat).
do $$ declare a uuid := pg_temp.player('Cloche1'); b uuid := pg_temp.player('Cloche2'); ids uuid[]; nb uuid[]; r jsonb; j jsonb;
  m jsonb := '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.","message":"Maintenance en cours, reviens dans quelques minutes."}';
  begin
  insert into public.notifications (user_id, type, data, created_at)
  select a, case when i = 52 then 'auction_outbid' else 'trade_received' end,
    case when i = 52 then jsonb_build_object('auction_id', gen_random_uuid(), 'card_id', gen_random_uuid(), 'card_title', 'Cloche X',
      'wikipedia_title', 'Cloche X', 'amount', 11)
    else jsonb_build_object('trade_id', gen_random_uuid(), 'user_id', b, 'username', 'Cloche2') end, now() - make_interval(secs => 55 - i)
  from generate_series(1, 55) i order by i;
  insert into public.notifications (user_id, type, data)
  select b, 'friend_request', jsonb_build_object('friendship_id', gen_random_uuid(), 'user_id', a, 'username', 'Cloche1') from generate_series(1, 3);
  ids := array(select id from public.notifications where user_id = a order by created_at desc);
  nb := array(select id from public.notifications where user_id = b);
  r := wm.notifications_list(a) -> 'notifications';
  assert cardinality(ids) = 55 and r = (select jsonb_agg(to_jsonb(n) - 'user_id' order by x.o) from unnest(ids[1:50]) with ordinality x (id, o)
    join public.notifications n on n.id = x.id), jsonb_path_query_array(r, '$[*].id')::text;
  assert not exists (select from jsonb_array_elements(r) e where array(select k from jsonb_object_keys(e) k order by k) <> '{created_at,data,id,read,type}'),
    'clés d''une notification';
  assert wm.notifications_read(a, array[ids[1], ids[2], nb[1]]) = '{"ok":true,"updated":2}', 'par ids';
  assert not exists (select from public.notifications where id = any (nb) and read), 'notification de B lue';
  assert wm.notifications_read(a, '{}') = '{"ok":true,"updated":0}', 'liste vide';
  assert wm.notifications_read(a) = '{"ok":true,"updated":53}', 'toutes';
  assert wm.notifications_read(a) = '{"ok":true,"updated":0}', 'second appel';
  insert into public.notifications (user_id, type) select a, 'trade_received' from generate_series(1, 3);
  assert wm.notifications_read(a, null, 'k-read') = '{"ok":true,"updated":3}' and wm.notifications_read(a, null, 'k-read') = '{"ok":true,"updated":3}',
    'rejeu à clé';
  update wm.config set value = 'true' where key = 'maintenance';
  assert pg_temp.err(format('select wm.notifications_read(%L)', a)) = m, coalesce(pg_temp.err(format('select wm.notifications_read(%L)', a))::text, 'lu');
  update wm.config set value = 'false' where key = 'maintenance';
  perform tests.login(a);
  set local enable_seqscan = off;
  execute 'explain (format json) select id from public.notifications where read = false limit 10' into j;
  reset enable_seqscan;
  perform tests.reset_role();
  assert strpos(j::text, '"notifications_unread_idx"') > 0, j::text;
end $$;

-- Volatilité des lectures (M3-R5) ; le marquage écrit.
do $$ begin
  assert (select jsonb_object_agg(proname, provolatile::text) from pg_proc where pronamespace = 'wm'::regnamespace
    and proname in ('trades_list', 'trade_detail', 'notifications_list', 'notifications_read'))
    = '{"trades_list":"s","trade_detail":"s","notifications_list":"s","notifications_read":"v"}', 'volatilité des lectures d''échange';
end $$;
