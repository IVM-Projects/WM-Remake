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

-- Index du D:810, définition complète.
do $$ declare bad text; begin
  select string_agg(v.n, ', ') into bad from (values
    ('trades_initiator_idx', 'public.trades USING btree (initiator_id, status, created_at DESC)'),
    ('trades_recipient_idx', 'public.trades USING btree (recipient_id, status, created_at DESC)'),
    ('trades_pending_expiry_idx', 'public.trades USING btree (expires_at) WHERE (status = ''pending''::trade_status)'),
    ('trades_parent_idx', 'public.trades USING btree (parent_trade_id) WHERE (parent_trade_id IS NOT NULL)'),
    ('trade_items_trade_idx', 'public.trade_items USING btree (trade_id)'),
    ('trade_items_offered_idx', 'public.trade_items USING btree (offered_by, card_id)'),
    ('friendships_requester_idx', 'public.friendships USING btree (requester_id)'),
    ('friendships_addressee_idx', 'public.friendships USING btree (addressee_id)')) v (n, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef = format('CREATE INDEX %s ON %s', v.n, v.def));
  assert bad is null, 'index absents ou différents : ' || bad;
end $$;

-- lock_timeout de 2 s (P5, M4-2) avant le premier verrou (for update, lock_users, lock_user) ; chaque tâche ajoute ses fonctions.
do $$ declare fs text[] := array['create_auction', 'bulk_discard', 'friend_request', 'friend_action', 'friend_remove', 'friend_accept_all'];
  bad text; begin
  select string_agg(f, ', ') into bad from unnest(fs) f, lateral (select prosrc s from pg_proc where oid = to_regproc('wm.' || f)) p,
    lateral (select strpos(s, 'perform set_config(''lock_timeout'', ''2s'', true);') t,
      (select min(i) from unnest(array[strpos(s, 'for update'), strpos(s, 'wm.lock_users('), strpos(s, 'wm.lock_user(')]) i where i > 0) l) x
  where not (t > 0 and t < l);
  assert bad is null, 'lock_timeout absent ou posé après un verrou : ' || bad;
  assert (select count(*) from unnest(fs) f where to_regproc('wm.' || f) is not null) = cardinality(fs), 'fonction absente';
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
  r := wm.friend_action(b, f, 'accept');
  assert r = jsonb_build_object('friendship', (select wm.friendship_json(x) from public.friendships x where id = f))
    and r #>> '{friendship,status}' = 'accepted', r::text;
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
  s := (select jsonb_object_agg(id, jsonb_build_array(status, closed_at is not null)) from public.trades where id in (t1, t2, t3, t4, t5));
  assert s = jsonb_build_object(t1, '["cancelled",true]'::jsonb, t2, '["cancelled",true]'::jsonb, t3, '["accepted",false]'::jsonb,
    t4, '["pending",false]'::jsonb, t5, '["pending",false]'::jsonb), s::text;
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
