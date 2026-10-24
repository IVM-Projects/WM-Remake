-- Push (1840_wm_push.sql, 9020_wm_push_cron.sql) : préférences opt-in par type, abonnements à liste blanche (B9), outbox remplie par le
-- trigger de notifications, réservation, push_gone, push_lag_s de wm.health(), réveil par de faux schémas net et vault.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ses cartes ; celui qui suppose une outbox vide
-- la vide d'abord (PF1).

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
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

-- p_items de create_trade : un élément par entrée de p_copies (répétée pour plusieurs unités), offert par p_by, au card_id de la copie.
create function pg_temp.items(p_by uuid, p_copies uuid[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_card_id', x, 'card_id', (select card_id from public.user_cards where id = x),
    'offered_by', p_by) order by o), '[]')
  from unnest(p_copies) with ordinality u (x, o)
$$;

-- Une notification, seule dans son instruction ; son id.
create function pg_temp.notify(p_uid uuid, p_type text default 'trade_received', p_at timestamptz default now()) returns uuid
language sql as $$
  insert into public.notifications (user_id, type, created_at) values (p_uid, p_type, p_at) returning id
$$;

-- Lignes d'outbox d'une notification.
create function pg_temp.outbox(p_notification uuid) returns int language sql as $$
  select count(*)::int from wm.push_outbox where notification_id = p_notification
$$;

-- Préférences (M4b-13) : vides sans ligne ; triées et dédoublonnées ; un type hors de push_types → 400 sans écriture ; rejeu par la clé.
do $$ declare a uuid := pg_temp.player('Prefs1'); r jsonb; d jsonb; begin
  assert wm.notification_prefs_get(a) = '{"push_types": []}', wm.notification_prefs_get(a)::text;
  r := wm.notification_prefs_set(a, array['trade_received', 'chat_message', 'chat_message']);
  assert r = '{"push_types": ["chat_message", "trade_received"]}' and wm.notification_prefs_get(a) = r, r::text;
  d := pg_temp.err(format('select wm.notification_prefs_set(%L, %L)', a, array['nope']));
  assert d = '{"status":400,"code":"invalid_request","error":"Type de notification inconnu","message":"Type de notification inconnu"}',
    coalesce(d::text, 'accepté');
  assert pg_temp.err(format('select wm.notification_prefs_set(%L, %L)', a, array['chat_message', null])) = d, 'type nul';
  assert wm.notification_prefs_get(a) = r, 'préférences écrites par un refus';
  r := wm.notification_prefs_set(a, array['auction_won'], 'k-prefs');
  assert wm.notification_prefs_set(a, array['friend_request'], 'k-prefs') = r and r = '{"push_types": ["auction_won"]}', 'rejeu de la clé';
  assert wm.notification_prefs_get(a) = r, 'écriture d''un rejeu';
  assert wm.notification_prefs_set(a, '{}') = '{"push_types": []}', 'tout décoché';
end $$;

-- Endpoint hostile ou voisin (B9, Review Focus) : les treize refus, plus http sur un hôte de suffixe et un \ dans le chemin d'une origine
-- listée (seule la règle \ le refuse), au corps exact et sans aucune ligne ; la casse et un hôte de suffixe passent, stockés tels quels.
-- Chaque \ est un seul caractère (standard_conforming_strings).
do $$ declare a uuid := pg_temp.player('Endpoint1'); d jsonb; e text; begin
  foreach e in array array['https://fcm.googleapis.com@evil.example/x', 'https://fcm.googleapis.com.evil.example/x',
    'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://a.notify.windows.com:8443/x', 'https://notify.windows.com/x',
    'https://evilnotify.windows.com/x', 'https://evil.example\.notify.windows.com/x', 'https://127.0.0.1\.notify.windows.com/x',
    'https:evil.example/x://a.notify.windows.com/', 'https://evil.example%2F.notify.windows.com/x', 'https://[::1]/x',
    'https://fcm.googleapis.com/fcm/send/' || (select string_agg(chr(19968 + n), '') from generate_series(1, 2000) n),
    'http://a.notify.windows.com/x', 'https://fcm.googleapis.com/fcm/send/a\b'] loop
    d := pg_temp.err(format('select wm.push_subscribe(%L, %L, %L, %L)', a, e, 'p', 'k'));
    assert d = '{"status":400,"code":"invalid_request","error":"Service de notifications non pris en charge",
      "message":"Service de notifications non pris en charge"}', left(e, 60) || ' : ' || coalesce(d::text, 'accepté');
  end loop;
  assert not exists (select from public.push_subscriptions where user_id = a), 'abonnement écrit par un refus';
  assert wm.push_subscribe(a, 'https://FCM.GOOGLEAPIS.COM/fcm/send/x', 'p', 'k') = '{"ok": true}'
    and wm.push_subscribe(a, 'https://wns2-par02p.notify.windows.com/w/?token=x', 'p', 'k') = '{"ok": true}', 'endpoints acceptés';
  assert (select array_agg(endpoint order by endpoint) from public.push_subscriptions where user_id = a)
    = array['https://FCM.GOOGLEAPIS.COM/fcm/send/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'], 'endpoints stockés';
end $$;

-- Abonnement (M4b-20) : le même endpoint deux fois → une ligne, aux dernières clés ; au-delà de 10, les plus récents restent, un endpoint
-- renvoyé redevenant récent ; un endpoint inconnu se désabonne sans erreur ; rejeu par la clé, sans seconde écriture.
do $$ declare a uuid := pg_temp.player('Abo1'); b uuid := pg_temp.player('Abo2'); e text := 'https://fcm.googleapis.com/fcm/send/abo';
  begin
  assert wm.push_subscribe(a, e, 'p1', 'k1') = '{"ok": true}' and wm.push_subscribe(a, e, 'p2', 'k2') = '{"ok": true}', 'abonnement';
  assert (select array_agg(p256dh || ' ' || auth) from public.push_subscriptions where user_id = a) = array['p2 k2'], 'une seule ligne';
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
  select b, e || n, 'p', 'k', now() - make_interval(mins => n) from generate_series(1, 10) n;
  assert wm.push_subscribe(b, e || '11', 'p', 'k') = '{"ok": true}', '11ᵉ abonnement';
  assert (select count(*) from public.push_subscriptions where user_id = b) = 10
    and not exists (select from public.push_subscriptions where endpoint = e || '10')
    and exists (select from public.push_subscriptions where endpoint = e || '11'), 'les 10 plus récents';
  assert wm.push_subscribe(b, e || '9', 'p', 'k') = '{"ok": true}' and wm.push_subscribe(b, e || '12', 'p', 'k') = '{"ok": true}', 'renvoi';
  assert (select count(*) from public.push_subscriptions where user_id = b) = 10
    and not exists (select from public.push_subscriptions where endpoint = e || '8')
    and exists (select from public.push_subscriptions where endpoint = e || '9'), 'endpoint renvoyé évincé';
  assert wm.push_unsubscribe(b, 'https://fcm.googleapis.com/fcm/send/inconnu') = '{"ok": true}', 'endpoint inconnu';
  assert (select count(*) from public.push_subscriptions where user_id = b) = 10, 'abonnement retiré par un endpoint inconnu';
  assert wm.push_unsubscribe(b, e || '11', 'k-unsub') = '{"ok": true}' and wm.push_subscribe(b, e || '11', 'p', 'k', 'k-sub') = '{"ok": true}'
    and wm.push_unsubscribe(b, e || '11', 'k-unsub') = '{"ok": true}' and wm.push_subscribe(b, e || '13', 'p', 'k', 'k-sub') = '{"ok": true}',
    'rejeux';
  assert exists (select from public.push_subscriptions where endpoint = e || '11')
    and not exists (select from public.push_subscriptions where endpoint = e || '13'), 'écriture d''un rejeu';
end $$;

-- Navigateur partagé (Review Focus) : B reprend l'endpoint de A ; la ligne posée pour A avant est consommée sans être rendue ; ensuite, une
-- notification de A n'écrit plus rien pour cet endpoint, une de B en écrit une ; le désabonnement de A laisse la ligne de B.
do $$ declare a uuid := pg_temp.player('Partage1'); b uuid := pg_temp.player('Partage2');
  e text := 'https://updates.push.services.mozilla.com/wpush/v2/partage'; n uuid; begin
  delete from wm.push_outbox where true;
  perform wm.notification_prefs_set(a, array['trade_received']);
  perform wm.push_subscribe(a, e, 'pa', 'ka');
  n := pg_temp.notify(a);
  assert pg_temp.outbox(n) = 1, 'notification de A';
  perform wm.push_subscribe(b, e, 'pb', 'kb');
  assert (select array_agg(user_id) from public.push_subscriptions where endpoint = e) = array[b], 'une ligne, à B';
  assert wm.push_claim() = '[]' and pg_temp.outbox(n) = 0, 'ligne de A rendue ou laissée';
  perform wm.notification_prefs_set(b, array['trade_received']);
  assert pg_temp.outbox(pg_temp.notify(a)) = 0 and pg_temp.outbox(pg_temp.notify(b)) = 1, 'notifications après la reprise';
  assert wm.push_unsubscribe(a, e) = '{"ok": true}', 'désabonnement de A';
  assert (select array_agg(user_id) from public.push_subscriptions where endpoint = e) = array[b], 'ligne de B retirée par A';
end $$;

-- Trigger (M4b-13) : une instruction de trois notifications → une ligne par abonnement de A, rien pour C (abonné sans ce type) ni pour D (non
-- abonné). Une notification de plus de 10 minutes (reprise) n'écrit rien, une de 9 minutes si.
do $$ declare a uuid := pg_temp.player('Trig1'); c uuid := pg_temp.player('Trig2'); d uuid := pg_temp.player('Trig3'); begin
  perform wm.notification_prefs_set(a, array['trade_received']);
  perform wm.notification_prefs_set(c, array['chat_message']);
  perform wm.push_subscribe(a, 'https://fcm.googleapis.com/fcm/send/trig-a1', 'p', 'k');
  perform wm.push_subscribe(a, 'https://web.push.apple.com/trig-a2', 'p', 'k');
  perform wm.push_subscribe(c, 'https://fcm.googleapis.com/fcm/send/trig-c', 'p', 'k');
  insert into public.notifications (user_id, type) select u, 'trade_received' from unnest(array[a, c, d]) u order by u;
  assert (select count(*) || ' ' || count(distinct o.subscription_id) || ' ' || count(*) filter (where n.user_id = a and s.user_id = a)
    from wm.push_outbox o join public.notifications n on n.id = o.notification_id left join public.push_subscriptions s on s.id = o.subscription_id
    where n.user_id in (a, c, d)) = '2 2 2', 'lignes d''outbox';
  assert pg_temp.outbox(pg_temp.notify(a, 'trade_received', now() - interval '11 minutes')) = 0, 'notification de 11 minutes';
  assert pg_temp.outbox(pg_temp.notify(a, 'trade_received', now() - interval '9 minutes')) = 2, 'notification de 9 minutes';
end $$;

-- Atomicité : l'outbox suit la notification annulée.
do $$ declare a uuid := pg_temp.player('Atome1'); k bigint; begin
  perform wm.notification_prefs_set(a, array['trade_received']);
  perform wm.push_subscribe(a, 'https://fcm.googleapis.com/fcm/send/atome', 'p', 'k');
  k := (select count(*) from wm.push_outbox);
  begin
    perform pg_temp.notify(a);
    assert (select count(*) from wm.push_outbox) = k + 1, 'ligne d''outbox absente';
    raise exception 'annulée' using errcode = 'XX000';
  exception when sqlstate 'XX000' then null;
  end;
  assert (select count(*) from wm.push_outbox) = k and not exists (select from public.notifications where user_id = a), 'outbox changée';
end $$;

-- Erreur injectée au dernier effet de l'acceptation (M4-7 A, « un échec annule l'événement ») : la ligne d'outbox de la trade_accepted de A
-- lève ; tout revient, outbox comprise. Sans le trigger, la même clé → accepted, une ligne d'outbox et la vitrine vide. La faute est sur
-- l'outbox : un trigger de ligne sur notifications partirait avant le trigger d'instruction qui l'écrit (mesuré sur PG16).
do $$ declare a uuid := pg_temp.player('PushFaute1'); b uuid := pg_temp.player('PushFaute2');
  a1 uuid := pg_temp.copy(a, pg_temp.card('PushFaute A1')); sa uuid; t uuid; s jsonb; r jsonb; begin
  perform pg_temp.friends(a, b);
  perform wm.notification_prefs_set(a, array['trade_accepted']);
  perform wm.push_subscribe(a, 'https://fcm.googleapis.com/fcm/send/vit', 'p', 'k');
  sa := (select id from public.push_subscriptions where user_id = a);
  insert into public.showcase (user_id, position, user_card_id) values (a, 0, a1);
  t := wm.create_trade(a, b, pg_temp.items(a, array[a1])) ->> 'id';
  s := tests.trade_snapshot(t);
  assert s ->> 'push_outbox' = '0', s::text;  -- la trade_received va à B, qui n'est pas abonné
  execute format('create trigger zz_boom after insert on wm.push_outbox for each row when (new.subscription_id = %L) '
    'execute function tests.boom()', sa);
  begin
    perform wm.trade_action(b, t, 'accept', null, 'k-out');
    assert false, 'faute non levée';
  exception when sqlstate 'XX000' then
    assert sqlerrm = 'erreur injectée', sqlerrm;
  end;
  assert tests.trade_snapshot(t) = s, tests.trade_snapshot(t)::text;
  drop trigger zz_boom on wm.push_outbox;
  assert wm.trade_action(b, t, 'accept', null, 'k-out') ->> 'status' = 'accepted', 'même clé sans trigger';
  r := tests.trade_snapshot(t);
  assert r ->> 'push_outbox' = '1' and r -> 'showcase' = '[]', r::text;
end $$;

-- Réservation (M4b-19, M4b-22) : par id, au plus p_limit ; la 4ᵉ ligne, dont l'abonnement a disparu, est consommée sans être rendue ;
-- les sept clés de l'interface ; limite nulle ou négative → rien ; la maintenance n'arrête pas la réservation.
do $$ declare a uuid := pg_temp.player('Claim1'); e text := 'https://fcm.googleapis.com/fcm/send/claim'; s1 uuid; s2 uuid; n uuid[];
  r jsonb; begin
  delete from wm.push_outbox where true;
  perform wm.push_subscribe(a, e, 'p-claim', 'k-claim');
  perform wm.push_subscribe(a, e || '-parti', 'p', 'k');
  s1 := (select id from public.push_subscriptions where endpoint = e);
  s2 := (select id from public.push_subscriptions where endpoint = e || '-parti');
  -- A n'a aucune préférence : le trigger n'écrit rien, les sept lignes sont posées à la main, dans l'ordre des notifications.
  with x as (insert into public.notifications (user_id, type, data) select a, 'friend_request', jsonb_build_object('i', i)
    from generate_series(1, 7) i returning id, data)
  select array_agg(id order by (data ->> 'i')::int) into n from x;
  insert into wm.push_outbox (subscription_id, notification_id)
  select case when o = 4 then s2 else s1 end, x from unnest(n) with ordinality u (x, o) order by o;
  delete from public.push_subscriptions where id = s2;
  r := wm.push_claim(3);
  assert r = (select jsonb_agg(jsonb_build_object('subscription_id', s1, 'endpoint', e, 'p256dh', 'p-claim', 'auth', 'k-claim',
    'notification_id', x, 'type', 'friend_request', 'data', jsonb_build_object('i', o)) order by o)
    from unnest(n) with ordinality u (x, o) where o <= 3), 'push_claim(3) : ' || r::text;
  r := wm.push_claim();
  assert r = (select jsonb_agg(jsonb_build_object('subscription_id', s1, 'endpoint', e, 'p256dh', 'p-claim', 'auth', 'k-claim',
    'notification_id', x, 'type', 'friend_request', 'data', jsonb_build_object('i', o)) order by o)
    from unnest(n) with ordinality u (x, o) where o >= 5), 'push_claim() : ' || r::text;
  assert wm.push_claim() = '[]' and not exists (select from wm.push_outbox), 'troisième appel';
  insert into wm.push_outbox (subscription_id, notification_id) values (s1, n[1]);
  assert wm.push_claim(null) = '[]' and wm.push_claim(-1) = '[]' and pg_temp.outbox(n[1]) = 1, 'limite nulle ou négative';
  update wm.config set value = 'true' where key = 'maintenance';
  r := wm.push_claim();
  update wm.config set value = 'false' where key = 'maintenance';
  assert jsonb_array_length(r) = 1 and r -> 0 ->> 'notification_id' = n[1]::text, 'maintenance : ' || r::text;
end $$;

-- Ligne de plus d'une heure (réveil coupé ou arrêté, sa purge avec lui, M4b-16) : consommée sans être rendue, quel que soit le drain ; celle
-- de 59 minutes est rendue.
do $$ declare a uuid := pg_temp.player('Vieille1'); s uuid; n1 uuid; n2 uuid; r jsonb; begin
  delete from wm.push_outbox where true;
  perform wm.push_subscribe(a, 'https://fcm.googleapis.com/fcm/send/vieille', 'p', 'k');
  s := (select id from public.push_subscriptions where user_id = a);
  -- A n'a aucune préférence : le trigger n'écrit rien, les lignes sont posées à la main.
  n1 := pg_temp.notify(a, 'friend_request');
  n2 := pg_temp.notify(a, 'friend_request');
  insert into wm.push_outbox (subscription_id, notification_id, created_at)
  values (s, n1, now() - interval '61 minutes'), (s, n2, now() - interval '59 minutes');
  r := wm.push_claim();
  assert jsonb_array_length(r) = 1 and r -> 0 ->> 'notification_id' = n2::text, 'push_claim() : ' || r::text;
  assert not exists (select from wm.push_outbox), 'ligne de plus d''une heure laissée';
end $$;

-- push_gone : les abonnements donnés, un id inconnu ignoré ; le nombre supprimé.
do $$ declare a uuid := pg_temp.player('Gone1'); s uuid[]; begin
  perform wm.push_subscribe(a, 'https://fcm.googleapis.com/fcm/send/gone' || i, 'p', 'k') from generate_series(1, 3) i;
  s := array(select id from public.push_subscriptions where user_id = a order by endpoint);
  assert wm.push_gone(array[s[1], s[2], gen_random_uuid()]) = 2, 'deux abonnements supprimés';
  assert (select array_agg(id) from public.push_subscriptions where user_id = a) = array[s[3]], 'abonnements restants';
end $$;

-- Santé (M4b-18) : push_lag_s nul sur une outbox vide, sinon l'âge de la plus vieille ligne.
do $$ begin
  delete from wm.push_outbox where true;
  assert wm.health() -> 'push_lag_s' = 'null'::jsonb, wm.health()::text;
  insert into wm.push_outbox (subscription_id, notification_id, created_at) values (gen_random_uuid(), gen_random_uuid(), now() - interval '30 seconds');
  insert into wm.push_outbox (subscription_id, notification_id) values (gen_random_uuid(), gen_random_uuid());
  assert wm.health() -> 'push_lag_s' = '30', wm.health()::text;
end $$;

-- 9020 sans pg_cron : sans erreur, ni schéma net ni job.
do $$ begin
  assert to_regnamespace('net') is null and to_regnamespace('cron') is null, 'schéma net ou cron avant 9020';
end $$;
\ir ../migrations/9020_wm_push_cron.sql
do $$ begin
  assert to_regnamespace('net') is null and to_regnamespace('cron') is null, 'schéma net ou cron créé par 9020 sans pg_cron';
end $$;

-- Réveil (M4b-16, M4b-17) par de faux pg_net et vault : sans URL ou outbox vide → null sans appel ; une ligne → un appel exact ; la purge
-- d'une heure passe d'abord et reste acquise ; secret absent, illisible ou vue absente → avertissement (attendu, masqué) et null.
do $$ declare l text := current_setting('client_min_messages'); u text := 'https://exemple.invalid/api/cron/push'; w bigint; begin
  create schema net;
  create table net.calls (url text, body jsonb, headers jsonb, timeout_milliseconds int);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}',
    timeout_milliseconds int default 2000) returns bigint language sql as $f$
    insert into net.calls values (url, body, headers, timeout_milliseconds) returning 1::bigint
  $f$;
  create schema vault;
  create view vault.decrypted_secrets as select 'CRON_SECRET'::text name, 'test-cron'::text decrypted_secret;
  delete from wm.push_outbox where true;
  insert into wm.push_outbox (subscription_id, notification_id) values (gen_random_uuid(), gen_random_uuid());
  w := wm.push_wake();  -- hors de l'assert : ses sous-requêtes liraient les tables dans l'instantané d'avant l'appel
  assert w is null and not exists (select from net.calls), 'sans URL';
  update wm.config set value = to_jsonb(u) where key = 'push_wake_url';
  delete from wm.push_outbox where true;
  w := wm.push_wake();
  assert w is null and not exists (select from net.calls), 'outbox vide';
  insert into wm.push_outbox (subscription_id, notification_id) values (gen_random_uuid(), gen_random_uuid());
  assert wm.push_wake() = 1, 'appel';
  assert (select jsonb_agg(to_jsonb(c)) from net.calls c) = jsonb_build_array(jsonb_build_object('url', u, 'body', '{}'::jsonb,
    'headers', '{"content-type": "application/json", "x-cron-secret": "test-cron"}'::jsonb, 'timeout_milliseconds', 10000)),
    (select jsonb_agg(to_jsonb(c)) from net.calls c)::text;
  delete from net.calls where true;
  delete from wm.push_outbox where true;
  insert into wm.push_outbox (subscription_id, notification_id, created_at) values (gen_random_uuid(), gen_random_uuid(), now() - interval '2 hours');
  w := wm.push_wake();
  assert w is null and not exists (select from wm.push_outbox) and not exists (select from net.calls), 'ligne de 2 h';
  perform set_config('client_min_messages', 'error', true);  -- avertissements attendus
  create or replace view vault.decrypted_secrets as select 'AUTRE'::text name, 'x'::text decrypted_secret;
  insert into wm.push_outbox (subscription_id, notification_id) values (gen_random_uuid(), gen_random_uuid());
  w := wm.push_wake();
  assert w is null and not exists (select from net.calls), 'secret absent';
  create function vault.deny() returns text language plpgsql as $f$ begin raise exception using errcode = '42501'; end $f$;
  create or replace view vault.decrypted_secrets as select 'CRON_SECRET'::text name, vault.deny() decrypted_secret;
  delete from wm.push_outbox where true;
  insert into wm.push_outbox (subscription_id, notification_id, created_at) values (gen_random_uuid(), gen_random_uuid(), now() - interval '2 hours');
  insert into wm.push_outbox (subscription_id, notification_id) values (gen_random_uuid(), gen_random_uuid());
  w := wm.push_wake();
  assert w is null and not exists (select from net.calls), 'secret illisible';
  assert (select count(*) from wm.push_outbox where created_at = now()) = 1 and (select count(*) from wm.push_outbox) = 1, 'purge annulée';
  drop view vault.decrypted_secrets;
  w := wm.push_wake();
  assert w is null and not exists (select from net.calls), 'vue absente';
  perform set_config('client_min_messages', l, true);
  update wm.config set value = 'null' where key = 'push_wake_url';
end $$;

-- Volatilité de la lecture ; lock_timeout (P5, M4b-2) avant la première écriture, qui prend FOR KEY SHARE sur le profil.
do $$ declare bad text; begin
  assert (select provolatile from pg_proc where oid = to_regproc('wm.notification_prefs_get')) = 's', 'notification_prefs_get volatile';
  bad := tests.lock_timeout_violations(array['push_subscribe', 'push_unsubscribe', 'notification_prefs_set'],
    array['public.push_subscriptions', 'wm.notification_prefs']);
  assert bad is null, 'lock_timeout absent ou posé après la première écriture : ' || bad;
end $$;
