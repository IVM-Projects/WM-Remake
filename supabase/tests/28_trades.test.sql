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
do $$ declare fs text[] := array['create_auction', 'bulk_discard']; bad text; begin
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

-- create_auction (M4-10) : copie verrouillée, autre copie de la même carte (par id de copie ou id catalogue) → 409 ; copie d'un autre,
-- même verrouillée, → 403 d'abord ; copie libre → mise en vente.
do $$ declare a uuid := pg_temp.player('Vente1'); b uuid := pg_temp.player('Vente2');
  x uuid := pg_temp.card('Vente X'); y uuid := pg_temp.card('Vente Y'); z uuid := pg_temp.card('Vente Z');
  ka uuid := pg_temp.copy(a, x); kb uuid := pg_temp.copy(b, y); q text := 'select wm.create_auction(%L, %L, 10, 60)'; r jsonb;
  d jsonb := '{"status":409,"error":"Cette carte est déjà engagée dans un échange en attente","message":"Cette carte est déjà engagée dans un échange en attente"}';
  begin
  perform pg_temp.friends(a, b);
  perform pg_temp.trade(a, b, array[ka, kb]);
  assert pg_temp.err(format(q, a, ka)) = d, coalesce(pg_temp.err(format(q, a, ka))::text, 'accepté');
  assert pg_temp.err(format(q, a, pg_temp.copy(a, x))) = d, 'seconde copie libre de X';
  assert pg_temp.err(format(q, a, x)) = d, 'id catalogue de X';
  assert pg_temp.err(format(q, a, kb)) = '{"status":403,"code":"42501","error":"Vous ne possédez pas cette carte","message":"Vous ne possédez pas cette carte"}',
    'copie d''un autre';
  r := wm.create_auction(a, pg_temp.copy(a, z), 10, 60);
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = '{auction_id,end_at,id}', r::text;
  assert (select count(*) from public.auctions where seller_id = a) = 1, 'une seule vente';
end $$;

-- bulk_discard (M4-10, P25) : la copie verrouillée va dans failed avec le message du verrou, la copie d'un autre avec le 403, dans l'ordre
-- reçu ; le reste passe ; la copie verrouillée garde son count.
do $$ declare a uuid := pg_temp.player('Defausse1'); b uuid := pg_temp.player('Defausse2');
  ka uuid := pg_temp.copy(a, pg_temp.card('Défausse X'), 2); kw uuid := pg_temp.copy(a, pg_temp.card('Défausse W'));
  kb uuid := pg_temp.copy(b, pg_temp.card('Défausse Y')); r jsonb; begin
  perform pg_temp.trade(a, b, array[ka]);
  r := wm.bulk_discard(a, array[ka, kw, kb]);
  assert r = jsonb_build_object('discarded_count', 1, 'failed', jsonb_build_array(
    jsonb_build_object('id', ka, 'reason', 'Cette carte est déjà engagée dans un échange en attente'),
    jsonb_build_object('id', kb, 'reason', 'Vous ne possédez pas cette carte'))), r::text;
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
