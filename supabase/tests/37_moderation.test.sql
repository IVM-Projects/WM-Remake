-- Modération (2200_wm_moderation_core.sql, puis 2210…2260) : config, audit, signalements d'image, comptes supprimés, index, actor qui refuse
-- un compte supprimé, email_hash, staff_actor, admin_reason, staff_log, auth_state, access_check, staff_me, sanction_json, scan de
-- couverture des wm.admin_* et wm.staff_* ; les tâches suivantes du M6a ajoutent leurs blocs.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ne filtre que sur eux.
-- check_invariants est global : un bloc qui crée une violation voulue la fait dans une sous-transaction annulée (WMT00,
-- 27_market.test.sql:278-285, P5a:47), et contrôle le résultat après.

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

-- Config du M6a (G5, G9, G10), chaque clé avec sa note.
create function pg_temp.mod_config() returns jsonb language sql as $$
  select jsonb_object_agg(key, value) from wm.config where key in ('image_reports', 'account_export', 'admin')
$$;

do $$ begin
  assert pg_temp.mod_config() = '{"image_reports":{"hide_threshold":10},"account_export":{"interval_s":600},
    "admin":{"page":50,"dm_messages":100,"guild_messages":100,"search":20,"removals":100}}'::jsonb, pg_temp.mod_config()::text;
  assert not exists (select from wm.config where key in ('image_reports', 'account_export', 'admin') and coalesce(note, '') = ''),
    'note manquante';
end $$;

-- Rejeu de 2200 : mêmes valeurs, et une valeur déjà posée garde la sienne.
create temp table mod_config as select pg_temp.mod_config() v;
update wm.config set value = '{"hide_threshold": 3}' where key = 'image_reports';
\ir ../migrations/2200_wm_moderation_core.sql
-- Une tâche suivante qui redéfinit actor ou staff_actor ajoute ici son propre \ir, après celui de 2200 (M5b-18).

-- Rejeu de 2210 (sanctions), sans lien avec la règle ci-dessus : la migration passe une seconde fois sur la base déjà migrée.
\ir ../migrations/2210_wm_sanctions.sql
do $$ begin
  assert pg_temp.mod_config() = jsonb_set((select v from mod_config), '{image_reports,hide_threshold}', '3'), pg_temp.mod_config()::text;
end $$;
update wm.config set value = '{"hide_threshold": 10}' where key = 'image_reports';

-- export_at d'un joueur neuf (G10).
do $$ declare u uuid := tests.make_user('ModState'); begin
  perform wm.lock_user(u);
  assert (select export_at is null from wm.user_state where user_id = u), 'export_at';
end $$;

-- Index du M6a, définition complète.
do $$ declare bad text; begin
  select string_agg(v.n, ', ') into bad from (values
    ('sanctions_user_idx', 'wm.sanctions USING btree (user_id, created_at DESC)'),
    ('staff_actions_created_idx', 'wm.staff_actions USING btree (created_at DESC, id DESC)'),
    ('staff_actions_target_idx', 'wm.staff_actions USING btree (target_type, target_id, created_at DESC)'),
    ('staff_actions_staff_idx', 'wm.staff_actions USING btree (staff_id, created_at DESC)'),
    ('card_image_reports_user_idx', 'wm.card_image_reports USING btree (user_id)'),
    ('reports_created_idx', 'public.reports USING btree (created_at DESC)'),
    ('trade_items_card_idx', 'public.trade_items USING btree (card_id)'),
    ('auctions_active_card_idx', 'public.auctions USING btree (card_id) WHERE (status = ''active''::auction_status)'),
    ('deleted_accounts_auth_pending_idx', 'wm.deleted_accounts USING btree (deleted_at) WHERE (auth_done_at IS NULL)')) v (n, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef = format('CREATE INDEX %s ON %s', v.n, v.def));
  assert bad is null, 'index absents ou différents : ' || bad;
end $$;

-- actor : compte supprimé → 401 exact ; compte normal → les quatre clés.
do $$ declare u uuid := tests.make_user('ModAct1'); v uuid := tests.make_user('ModAct2'); d jsonb; begin
  insert into wm.deleted_accounts (user_id) values (u);
  d := pg_temp.err(format('select wm.actor(%L)', u));
  assert d = '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}'::jsonb, d::text;
  assert wm.actor(v) = '{"is_pro":false,"is_vip":false,"is_staff":false,"staff_role":null}'::jsonb, wm.actor(v)::text;
end $$;

-- email_hash : rogné, minuscules, immuable.
do $$ begin
  assert wm.email_hash('  Alice@Example.org ') = encode(sha256(convert_to('alice@example.org', 'UTF8')), 'hex'), 'email_hash';
  assert wm.email_hash(null) is null, 'email_hash nul';
  assert (select provolatile from pg_proc where oid = 'wm.email_hash(text)'::regprocedure) = 'i', 'email_hash immutable';
end $$;

-- staff_actor : rôles, maintenance ignorée, staff sanctionné refusé, sanction levée, compte supprimé.
do $$ declare pl uuid := tests.make_user('ModPl'); mo uuid := tests.make_user('ModMo'); ad uuid := tests.make_user('ModAd');
  m2 uuid := tests.make_user('ModMo2'); a2 uuid := tests.make_user('ModAd2'); dl uuid := tests.make_user('ModDel'); d jsonb; begin
  insert into wm.staff (user_id, role) values (mo, 'moderator'), (ad, 'admin'), (m2, 'moderator'), (a2, 'admin'), (dl, 'admin');
  d := pg_temp.err(format('select wm.staff_actor(%L)', pl));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Accès réservé à l''équipe de modération","message":"Accès réservé à l''équipe de modération"}'::jsonb,
    d::text;
  d := pg_temp.err(format('select wm.staff_actor(%L, %L)', mo, 'admin'));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Action réservée aux administrateurs","message":"Action réservée aux administrateurs"}'::jsonb,
    d::text;
  assert wm.staff_actor(mo) = 'moderator', 'modérateur';
  assert wm.staff_actor(ad) = 'admin' and wm.staff_actor(ad, 'admin') = 'admin', 'admin';
  update wm.config set value = 'true' where key = 'maintenance';
  assert wm.staff_actor(ad, 'admin') = 'admin', 'maintenance ignorée';
  update wm.config set value = 'false' where key = 'maintenance';
  insert into wm.sanctions (user_id, kind) values (a2, 'ban');
  d := pg_temp.err(format('select wm.staff_actor(%L)', a2));
  assert d = '{"status":403,"error":"Ton compte est temporairement restreint.","message":"Ton compte est temporairement restreint.","activity_blocked_until":null}'::jsonb,
    d::text;
  insert into wm.sanctions (user_id, kind, ends_at) values (m2, 'restriction', now() + interval '1 day');
  d := pg_temp.err(format('select wm.staff_actor(%L)', m2));
  assert d ->> 'status' = '403' and d ->> 'message' = 'Ton compte est temporairement restreint.'
    and (d ->> 'activity_blocked_until')::timestamptz = now() + interval '1 day', d::text;
  update wm.sanctions set revoked_at = now() where user_id in (a2, m2);
  assert wm.staff_actor(a2) = 'admin' and wm.staff_actor(m2) = 'moderator', 'sanction levée';
  -- activity_blocked_until futur sans sanction : passe (G3, comme access_check).
  update public.profiles set activity_blocked_until = now() + interval '1 day' where id = a2;
  assert wm.staff_actor(a2, 'admin') = 'admin', 'activity_blocked_until seul';
  insert into wm.deleted_accounts (user_id) values (dl);
  d := pg_temp.err(format('select wm.staff_actor(%L)', dl));
  assert d ->> 'status' = '401' and d ->> 'code' = 'unauthorized', d::text;
  d := pg_temp.err(format('select wm.staff_actor(%L)', gen_random_uuid()));
  assert d ->> 'status' = '401', 'inconnu';
end $$;

-- admin_reason : rogné, 3 à 500 caractères.
do $$ declare d jsonb; begin
  d := pg_temp.err('select wm.admin_reason(''  ok  '')');
  assert d = '{"status":400,"code":"invalid_request","error":"Le motif est obligatoire (3 à 500 caractères)","message":"Le motif est obligatoire (3 à 500 caractères)"}'::jsonb,
    d::text;
  assert pg_temp.err('select wm.admin_reason(null)') ->> 'status' = '400', 'nul';
  assert pg_temp.err(format('select wm.admin_reason(%L)', repeat('a', 501))) ->> 'status' = '400', '501';
  assert wm.admin_reason(' Triche avérée ') = 'Triche avérée', 'rogné';
  assert wm.admin_reason(repeat('é', 500)) = repeat('é', 500), '500';
end $$;

-- staff_log : une ligne aux valeurs exactes ; motif trop court refusé par la table ; staff_id nul permis.
do $$ declare s uuid := tests.make_user('ModLog'); i bigint; j bigint; r wm.staff_actions; begin
  i := wm.staff_log(s, 'sanction_create', 'user', s::text, 'Triche avérée', '{"kind": "warning"}');
  select * into r from wm.staff_actions where id = i;
  assert r.staff_id = s and r.action = 'sanction_create' and r.target_type = 'user' and r.target_id = s::text and r.reason = 'Triche avérée'
    and r.payload = '{"kind": "warning"}' and r.created_at = now(), to_jsonb(r)::text;
  begin
    insert into wm.staff_actions (staff_id, action, target_type, target_id, reason) values (s, 'x', 'user', s::text, 'ab');
    assert false, 'motif de 2 caractères accepté';
  exception when check_violation then null;
  end;
  j := wm.staff_log(null, 'image_auto_hide', 'card', gen_random_uuid()::text, 'Seuil de signalements atteint');
  assert (select staff_id is null and payload = '{}' from wm.staff_actions where id = j), 'système';
end $$;

-- auth_state et access_check, un joueur par cas.
do $$ declare
  n uuid := tests.make_user('ModN'); w uuid := tests.make_user('ModW'); s uuid := tests.make_user('ModS'); b uuid := tests.make_user('ModB');
  r uuid := tests.make_user('ModR'); x uuid := tests.make_user('ModX'); l uuid := tests.make_user('ModL'); dl uuid := tests.make_user('ModD');
  j3 timestamptz := now() + interval '3 days'; d jsonb; begin
  assert wm.auth_state(n) = jsonb_build_object('user_id', n, 'deleted', false, 'forever', false, 'ban_until', null), wm.auth_state(n)::text;
  assert wm.access_check(n) = '{"ok": true}', 'aucun';
  insert into wm.sanctions (user_id, kind) values (w, 'warning');
  insert into wm.sanctions (user_id, kind, ends_at) values (w, 'restriction', j3);
  assert wm.auth_state(w) = jsonb_build_object('user_id', w, 'deleted', false, 'forever', false, 'ban_until', null), wm.auth_state(w)::text;
  assert wm.access_check(w) = '{"ok": true}', 'avertissement et restriction';
  insert into wm.sanctions (user_id, kind, ends_at) values (s, 'suspension', j3);
  assert wm.auth_state(s) = jsonb_build_object('user_id', s, 'deleted', false, 'forever', false, 'ban_until', j3), wm.auth_state(s)::text;
  d := pg_temp.err(format('select wm.access_check(%L)', s));
  assert d = jsonb_build_object('status', 403, 'error', 'Ton compte est temporairement restreint.',
    'message', 'Ton compte est temporairement restreint.', 'activity_blocked_until', j3), d::text;
  insert into wm.sanctions (user_id, kind, ends_at) values (b, 'suspension', j3);
  insert into wm.sanctions (user_id, kind) values (b, 'ban');
  assert wm.auth_state(b) = jsonb_build_object('user_id', b, 'deleted', false, 'forever', true, 'ban_until', null), wm.auth_state(b)::text;
  d := pg_temp.err(format('select wm.access_check(%L)', b));
  assert d = '{"status":403,"error":"Ton compte est temporairement restreint.","message":"Ton compte est temporairement restreint.","activity_blocked_until":null}'::jsonb,
    d::text;
  insert into wm.sanctions (user_id, kind, revoked_at) values (r, 'ban', now());
  insert into wm.sanctions (user_id, kind, starts_at, ends_at) values (r, 'suspension', now() - interval '2 days', now() - interval '1 day');
  assert wm.auth_state(r) = jsonb_build_object('user_id', r, 'deleted', false, 'forever', false, 'ban_until', null), wm.auth_state(r)::text;
  assert wm.access_check(r) = '{"ok": true}', 'levée ou échue';
  update public.profiles set activity_blocked_until = j3 where id = x;
  assert wm.access_check(x) = '{"ok": true}', 'activity_blocked_until seul';
  insert into wm.deleted_accounts (user_id) values (dl);
  assert (wm.auth_state(dl) ->> 'deleted')::boolean, 'supprimé';
  d := pg_temp.err(format('select wm.access_check(%L)', dl));
  assert d = '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}'::jsonb, d::text;
  d := pg_temp.err(format('select wm.access_check(%L)', gen_random_uuid()));
  assert d ->> 'status' = '401' and d ->> 'code' = 'unauthorized', 'inconnu';
  -- Ban daté à venir : pas encore actif.
  insert into wm.sanctions (user_id, kind, starts_at) values (l, 'ban', now() + interval '1 hour');
  assert wm.access_check(l) = '{"ok": true}' and not (wm.auth_state(l) ->> 'forever')::boolean, 'ban futur';
end $$;

-- staff_me : jamais d'erreur.
do $$ declare pl uuid := tests.make_user('ModMe1'); mo uuid := tests.make_user('ModMe2'); dl uuid := tests.make_user('ModMe3'); begin
  insert into wm.staff (user_id, role) values (mo, 'moderator'), (dl, 'admin');
  insert into wm.deleted_accounts (user_id) values (dl);
  assert wm.staff_me(pl) = '{"role": null}', 'joueur';
  assert wm.staff_me(mo) = '{"role": "moderator"}', 'modérateur';
  assert wm.staff_me(dl) = '{"role": null}', 'supprimé';
  assert wm.staff_me(gen_random_uuid()) = '{"role": null}', 'inconnu';
end $$;

-- sanction_json : active, levée, à venir ; pseudo de l'auteur.
do $$ declare u uuid := tests.make_user('ModSj'); st uuid := tests.make_user('ModSjStaff'); s wm.sanctions; begin
  insert into wm.sanctions (user_id, kind, ends_at, created_by) values (u, 'restriction', now() + interval '1 day', st) returning * into s;
  assert (wm.sanction_json(s) ->> 'active')::boolean and wm.sanction_json(s) ->> 'created_by_username' = 'ModSjStaff'
    and wm.sanction_json(s) - 'active' - 'created_by_username' = to_jsonb(s), wm.sanction_json(s)::text;
  update wm.sanctions set revoked_at = now() where id = s.id returning * into s;
  assert not (wm.sanction_json(s) ->> 'active')::boolean, 'levée';
  insert into wm.sanctions (user_id, kind, starts_at) values (u, 'warning', now() + interval '1 hour') returning * into s;
  assert not (wm.sanction_json(s) ->> 'active')::boolean and wm.sanction_json(s) -> 'created_by_username' = 'null', 'à venir, système';
end $$;

-- ===== 2210 : sanctions, levée, état GoTrue, « Rouvrir le check », recherche et fiche d'un joueur =====

create function pg_temp.staff(p_role text) returns uuid language plpgsql as $$
declare u uuid := tests.make_user('Staff' || substr(md5(random()::text), 1, 10)); begin
  insert into wm.staff (user_id, role) values (u, p_role);
  return u;
end $$;

create function pg_temp.player(p_name text) returns uuid language sql as $$ select tests.make_user(p_name) $$;

-- Corps d'erreur attendu (wm.raise_err).
create function pg_temp.e(p_status int, p_code text, p_msg text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_msg, 'message', p_msg))
$$;

-- Un refus : le corps d'erreur, sans sanction, levée, audit ni clé d'idempotence écrits.
create function pg_temp.refused(p_sql text) returns jsonb language plpgsql as $$
declare
  n text := (select jsonb_build_array((select count(*) from wm.sanctions), (select count(*) from wm.sanctions where revoked_at is not null),
    (select count(*) from wm.staff_actions), (select count(*) from wm.idempotency_keys), (select count(*) from wm.report_reviews))::text);
  d jsonb;
begin
  d := pg_temp.err(p_sql);
  assert d is not null, 'aucun refus : ' || p_sql;
  assert n = (select jsonb_build_array((select count(*) from wm.sanctions), (select count(*) from wm.sanctions where revoked_at is not null),
    (select count(*) from wm.staff_actions), (select count(*) from wm.idempotency_keys), (select count(*) from wm.report_reviews))::text),
    'écriture sur refus : ' || p_sql;
  return d;
end $$;

create function pg_temp.sanction(p_uid uuid, p_user uuid, p_kind text, p_ends timestamptz default null) returns bigint language sql as $$
  select (wm.admin_sanction(p_uid, p_user, p_kind, p_ends, 'Motif de test') -> 'sanction' ->> 'id')::bigint
$$;

-- Pose : bannissement par un admin, réponse, audit exact, écritures et lectures refusées.
do $$ declare a uuid := pg_temp.staff('admin'); b uuid := pg_temp.player('SanBan'); r jsonb; d jsonb; x wm.staff_actions; s wm.sanctions;
begin
  r := wm.admin_sanction(a, b, 'ban', null, '  Triche avérée ');
  select * into s from wm.sanctions where user_id = b;
  assert s.kind = 'ban' and s.ends_at is null and s.reason = 'Triche avérée' and s.created_by = a and s.revoked_at is null, to_jsonb(s)::text;
  assert r = jsonb_build_object('sanction', wm.sanction_json(s), 'auth', jsonb_build_object('user_id', b, 'deleted', false, 'forever', true,
    'ban_until', null)), r::text;
  assert r -> 'sanction' ->> 'kind' = 'ban' and r -> 'sanction' -> 'ends_at' = 'null' and (r -> 'sanction' ->> 'active')::boolean, r::text;
  assert (select count(*) from wm.staff_actions where staff_id = a) = 1, 'une ligne d''audit';
  select * into x from wm.staff_actions where staff_id = a;
  assert x.action = 'sanction' and x.target_type = 'user' and x.target_id = b::text and x.reason = 'Triche avérée'
    and x.payload = jsonb_build_object('sanction_id', s.id, 'kind', 'ban', 'ends_at', null, 'report_id', null), to_jsonb(x)::text;
  d := pg_temp.err(format('select wm.actor(%L)', b));
  assert d = pg_temp.e(403, null, 'Ton compte est temporairement restreint.') || '{"activity_blocked_until": null}', d::text;
  d := pg_temp.err(format('select wm.access_check(%L)', b));
  assert d = pg_temp.e(403, null, 'Ton compte est temporairement restreint.') || '{"activity_blocked_until": null}', d::text;
end $$;

-- Suspension de 3 jours, restriction de 2 jours par un modérateur, avertissement sans effet.
do $$ declare a uuid := pg_temp.staff('admin'); m uuid := pg_temp.staff('moderator'); su uuid := pg_temp.player('SanSusp');
  re uuid := pg_temp.player('SanRestr'); wa uuid := pg_temp.player('SanWarn'); r jsonb; d jsonb; begin
  r := wm.admin_sanction(a, su, 'suspension', now() + interval '3 days', 'Insultes répétées');
  assert r -> 'auth' = jsonb_build_object('user_id', su, 'deleted', false, 'forever', false, 'ban_until', now() + interval '3 days'), r::text;
  assert (r -> 'sanction' ->> 'ends_at')::timestamptz = now() + interval '3 days', r::text;
  assert pg_temp.err(format('select wm.access_check(%L)', su)) ->> 'status' = '403', 'suspension : lecture';
  r := wm.admin_sanction(m, re, 'restriction', now() + interval '2 days', 'Spam au marché');
  assert r -> 'auth' ->> 'ban_until' is null and not (r -> 'auth' ->> 'forever')::boolean, r::text;
  d := pg_temp.err(format('select wm.actor(%L)', re));
  assert d = pg_temp.e(403, null, 'Ton compte est temporairement restreint.')
    || jsonb_build_object('activity_blocked_until', now() + interval '2 days'), d::text;
  assert wm.access_check(re) = '{"ok": true}', 'restriction : lecture';
  r := wm.admin_sanction(m, wa, 'warning', null, 'Premier avertissement');
  assert r -> 'sanction' ->> 'kind' = 'warning' and r -> 'auth' = jsonb_build_object('user_id', wa, 'deleted', false, 'forever', false,
    'ban_until', null), r::text;
  assert wm.actor(wa) ->> 'is_staff' = 'false' and wm.access_check(wa) = '{"ok": true}', 'avertissement';
end $$;

-- Refus exacts de la pose, chacun sans sanction ni audit.
do $$ declare a uuid := pg_temp.staff('admin'); a2 uuid := pg_temp.staff('admin'); m uuid := pg_temp.staff('moderator');
  b uuid := pg_temp.player('SanRef'); p uuid := pg_temp.player('SanRefPl'); dl uuid := pg_temp.player('SanRefDel'); d jsonb;
  admin_only jsonb := pg_temp.e(403, 'FORBIDDEN', 'Action réservée aux administrateurs');
  bad_end jsonb := pg_temp.e(400, 'invalid_request', 'La date de fin doit être dans le futur, à un an au plus'); begin
  insert into wm.deleted_accounts (user_id) values (dl);
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, %L, %L)', m, b, 'suspension', now() + interval '1 day', 'Motif ok'));
  assert d = admin_only, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', m, b, 'ban', 'Motif ok'));
  assert d = admin_only, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', m, a2, 'warning', 'Motif ok'));
  assert d = admin_only, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', a, a, 'warning', 'Motif ok'));
  assert d = pg_temp.e(400, 'invalid_request', 'Tu ne peux pas te sanctionner toi-même'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', a, b, 'x', 'Motif ok'));
  assert d = pg_temp.e(400, 'invalid_request', 'Sanction inconnue'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, %L, %L)', a, b, 'ban', now() + interval '1 day', 'Motif ok'));
  assert d = pg_temp.e(400, 'invalid_request', 'Pas de date de fin pour ce type de sanction'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, %L, %L)', a, b, 'warning', now() + interval '1 day', 'Motif ok'));
  assert d = pg_temp.e(400, 'invalid_request', 'Pas de date de fin pour ce type de sanction'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', a, b, 'suspension', 'Motif ok'));
  assert d = bad_end, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, %L, %L)', a, b, 'suspension', now() - interval '1 second', 'Motif ok'));
  assert d = bad_end, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, %L, %L)', a, b, 'suspension', now(), 'Motif ok'));
  assert d = bad_end, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, %L, %L)', a, b, 'suspension', now() + interval '366 days', 'Motif ok'));
  assert d = bad_end, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', m, b, 'restriction', 'Motif ok'));
  assert d = bad_end, d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', a, gen_random_uuid(), 'warning', 'Motif ok'));
  assert d = pg_temp.e(404, null, 'Joueur introuvable'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', a, dl, 'warning', 'Motif ok'));
  assert d = pg_temp.e(404, null, 'Joueur introuvable'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L)', p, b, 'warning', 'Motif ok'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction(%L, %L, %L, null, %L, null, %L)', a, b, 'warning', '  ', 'k-vide'));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
  -- Bornes acceptées : un an pile, et un admin qui avertit un modérateur.
  perform pg_temp.sanction(a, b, 'suspension', now() + interval '365 days');
  perform pg_temp.sanction(a, m, 'warning');
end $$;

-- Signalement : un rapport qui vise le joueur passe à resolved, rattaché à l'audit ; un autre est ignoré.
do $$ declare a uuid := pg_temp.staff('admin'); b uuid := pg_temp.player('SanRepB'); c uuid := pg_temp.player('SanRepC');
  o uuid := pg_temp.player('SanRepO'); rb uuid; ro uuid; r jsonb; v wm.report_reviews; begin
  insert into public.reports (reporter_id, reported_user_id, reason) values (c, b, 'cheating') returning id into rb;
  insert into public.reports (reporter_id, reported_user_id, reason) values (c, o, 'spam') returning id into ro;
  r := wm.admin_sanction(a, b, 'warning', null, 'Triche signalée', rb);
  select * into v from wm.report_reviews where report_id = rb;
  assert v.status = 'resolved' and v.reviewed_by = a and v.reviewed_at = now()
    and v.staff_action_id = (select id from wm.staff_actions where staff_id = a and payload ->> 'report_id' = rb::text), to_jsonb(v)::text;
  r := wm.admin_sanction(a, b, 'warning', null, 'Mauvais signalement', ro);
  assert r -> 'sanction' ->> 'kind' = 'warning' and not exists (select from wm.report_reviews where report_id = ro), 'rapport ignoré';
  assert (select count(*) from wm.sanctions where user_id = b) = 2, 'deux sanctions';
end $$;

-- Levée : état, audit exact, 409 ensuite ; modérateur sur un ban ; id inconnu.
do $$ declare a uuid := pg_temp.staff('admin'); m uuid := pg_temp.staff('moderator'); b uuid := pg_temp.player('SanRev');
  b2 uuid := pg_temp.player('SanRev2'); i bigint; j bigint; r jsonb; d jsonb; x wm.staff_actions; begin
  i := pg_temp.sanction(a, b, 'ban');
  r := wm.admin_sanction_revoke(a, i, ' Erreur de cible ');
  assert (r -> 'sanction' ->> 'revoked_at')::timestamptz = now() and not (r -> 'sanction' ->> 'active')::boolean, r::text;
  assert r -> 'auth' = jsonb_build_object('user_id', b, 'deleted', false, 'forever', false, 'ban_until', null), r::text;
  assert r -> 'sanction' = (select wm.sanction_json(s) from wm.sanctions s where id = i), r::text;
  assert wm.actor(b) ->> 'is_staff' = 'false', 'actor passe';
  select * into x from wm.staff_actions where action = 'sanction_revoke' and target_id = i::text;
  assert x.staff_id = a and x.target_type = 'sanction' and x.reason = 'Erreur de cible'
    and x.payload = jsonb_build_object('user_id', b, 'kind', 'ban'), to_jsonb(x)::text;
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', a, i, 'Encore une fois'));
  assert d = pg_temp.e(409, null, 'Cette sanction est déjà levée'), d::text;
  j := pg_temp.sanction(a, b2, 'ban');
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', m, j, 'Levée par un modérateur'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Action réservée aux administrateurs'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', a, -1, 'Id inconnu'));
  assert d = pg_temp.e(404, null, 'Sanction introuvable'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', pg_temp.player('SanRevPl'), j, 'Levée par un joueur'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', a, j, ''));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
  -- Un modérateur lève la restriction d'un joueur.
  j := pg_temp.sanction(m, b2, 'restriction', now() + interval '1 day');
  assert (wm.admin_sanction_revoke(m, j, 'Restriction levée') -> 'sanction' ->> 'revoked_at') is not null, 'modérateur, restriction';
end $$;

-- Staff qui outrepasse (Review Focus) : chacun 403 sans levée ni audit.
do $$ declare a1 uuid := pg_temp.staff('admin'); a2 uuid := pg_temp.staff('admin'); m uuid := pg_temp.staff('moderator');
  mw uuid := pg_temp.staff('moderator'); m2 uuid := pg_temp.staff('moderator'); i bigint; d jsonb;
  admin_only jsonb := pg_temp.e(403, 'FORBIDDEN', 'Action réservée aux administrateurs'); begin
  i := pg_temp.sanction(a1, m, 'restriction', now() + interval '1 day');
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', m, i, 'Je me lève'));
  assert d = pg_temp.e(403, null, 'Ton compte est temporairement restreint.')
    || jsonb_build_object('activity_blocked_until', now() + interval '1 day'), d::text;
  i := pg_temp.sanction(a1, mw, 'warning');
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', mw, i, 'Je me lève'));
  assert d = admin_only, d::text;
  i := pg_temp.sanction(a1, m2, 'warning');
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', mw, i, 'Pour un collègue'));
  assert d = admin_only, d::text;
  i := pg_temp.sanction(a1, a2, 'warning');
  assert (wm.admin_sanction_revoke(a1, i, 'Pour un admin') -> 'sanction' ->> 'revoked_at') is not null, 'admin lève un admin';
  i := pg_temp.sanction(a2, a1, 'warning');
  d := pg_temp.refused(format('select wm.admin_sanction_revoke(%L, %L, %L)', a1, i, 'Je me lève'));
  assert d = admin_only, d::text;
end $$;

-- Idempotence : même clé deux fois → même corps, un seul effet, une seule ligne d'audit.
do $$ declare a uuid := pg_temp.staff('admin'); b uuid := pg_temp.player('SanIdem'); r1 jsonb; r2 jsonb; i bigint; begin
  r1 := wm.admin_sanction(a, b, 'warning', null, 'Clé rejouée', null, 'k-sanction');
  r2 := wm.admin_sanction(a, b, 'warning', null, 'Clé rejouée', null, 'k-sanction');
  assert r1 = r2 and (select count(*) from wm.sanctions where user_id = b) = 1
    and (select count(*) from wm.staff_actions where staff_id = a and action = 'sanction') = 1, 'sanction : ' || r2::text;
  i := (r1 -> 'sanction' ->> 'id')::bigint;
  r1 := wm.admin_sanction_revoke(a, i, 'Clé rejouée', 'k-revoke');
  r2 := wm.admin_sanction_revoke(a, i, 'Clé rejouée', 'k-revoke');
  assert r1 = r2 and (select count(*) from wm.staff_actions where staff_id = a and action = 'sanction_revoke') = 1, 'levée : ' || r2::text;
  r1 := wm.admin_auth_sync(a, b, 'Clé rejouée', 'k-sync');
  r2 := wm.admin_auth_sync(a, b, 'Clé rejouée', 'k-sync');
  assert r1 = r2 and (select count(*) from wm.staff_actions where staff_id = a and action = 'auth_sync') = 1, 'sync : ' || r2::text;
  perform wm.lock_user(b);
  update wm.user_state set achievements_checked_at = now() where user_id = b;
  r1 := wm.admin_achievements_recheck(a, b, 'Clé rejouée', 'k-recheck');
  update wm.user_state set achievements_checked_at = now() where user_id = b;
  r2 := wm.admin_achievements_recheck(a, b, 'Clé rejouée', 'k-recheck');
  assert r1 = r2 and (select achievements_checked_at is not null from wm.user_state where user_id = b)
    and (select count(*) from wm.staff_actions where staff_id = a and action = 'achievements_recheck') = 1, 'recheck : ' || r2::text;
end $$;

-- admin_auth_sync : admin seul, compte supprimé visé, audit exact, aucune autre écriture.
do $$ declare a uuid := pg_temp.staff('admin'); m uuid := pg_temp.staff('moderator'); b uuid := pg_temp.player('SanSync'); r jsonb; d jsonb;
  x wm.staff_actions; begin
  perform pg_temp.sanction(a, b, 'suspension', now() + interval '2 days');
  insert into wm.deleted_accounts (user_id) values (b);
  r := wm.admin_auth_sync(a, b, ' Session à rattraper ');
  assert r = jsonb_build_object('auth', jsonb_build_object('user_id', b, 'deleted', true, 'forever', false,
    'ban_until', now() + interval '2 days')), r::text;
  select * into x from wm.staff_actions where action = 'auth_sync' and staff_id = a;
  assert x.target_type = 'user' and x.target_id = b::text and x.reason = 'Session à rattraper' and x.payload = r, to_jsonb(x)::text;
  d := pg_temp.refused(format('select wm.admin_auth_sync(%L, %L, %L)', m, b, 'Par un modérateur'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Action réservée aux administrateurs'), d::text;
  d := pg_temp.refused(format('select wm.admin_auth_sync(%L, %L, %L)', a, gen_random_uuid(), 'Inconnu'));
  assert d = pg_temp.e(404, null, 'Joueur introuvable'), d::text;
  d := pg_temp.refused(format('select wm.admin_auth_sync(%L, %L, %L)', a, b, 'ab'));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
end $$;

-- admin_achievements_recheck : achievements_checked_at posé puis nul, audit exact ; refus.
do $$ declare m uuid := pg_temp.staff('moderator'); b uuid := pg_temp.player('SanCheck'); dl uuid := pg_temp.player('SanCheckDel');
  r jsonb; d jsonb; x wm.staff_actions; begin
  perform wm.lock_user(b);
  update wm.user_state set achievements_checked_at = now() where user_id = b;
  assert (select achievements_checked_at = now() from wm.user_state where user_id = b), 'posé';
  r := wm.admin_achievements_recheck(m, b, 'Succès manquant');
  assert r = '{"ok": true}' and (select achievements_checked_at is null from wm.user_state where user_id = b), r::text;
  select * into x from wm.staff_actions where action = 'achievements_recheck' and staff_id = m;
  assert x.target_type = 'user' and x.target_id = b::text and x.reason = 'Succès manquant' and x.payload = '{}', to_jsonb(x)::text;
  insert into wm.deleted_accounts (user_id) values (dl);
  d := pg_temp.refused(format('select wm.admin_achievements_recheck(%L, %L, %L)', m, dl, 'Compte supprimé'));
  assert d = pg_temp.e(404, null, 'Joueur introuvable'), d::text;
  d := pg_temp.refused(format('select wm.admin_achievements_recheck(%L, %L, %L)', m, gen_random_uuid(), 'Inconnu'));
  assert d = pg_temp.e(404, null, 'Joueur introuvable'), d::text;
  d := pg_temp.refused(format('select wm.admin_achievements_recheck(%L, %L, %L)', pg_temp.player('SanCheckPl'), b, 'Par un joueur'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  d := pg_temp.refused(format('select wm.admin_achievements_recheck(%L, %L, null)', m, b));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
end $$;

-- staff_user_search : début de pseudo insensible à la casse, % et _ littéraux, 2 caractères au moins, 20 au plus.
do $$ declare m uuid := pg_temp.staff('moderator'); al1 uuid := pg_temp.player('Alpha1'); al2 uuid := pg_temp.player('alBeta'); r jsonb;
  d jsonb; begin
  perform pg_temp.player('xAlpha');
  perform pg_temp.player('abPct');
  perform pg_temp.player('a_Und');
  insert into wm.deleted_accounts (user_id) values (al2);
  r := wm.staff_user_search(m, ' AL ');
  assert r = jsonb_build_object('users', jsonb_build_array(
    jsonb_build_object('id', al2, 'username', 'alBeta', 'created_at', now(), 'deleted', true),
    jsonb_build_object('id', al1, 'username', 'Alpha1', 'created_at', now(), 'deleted', false))), r::text;
  -- Un pseudo ne contient jamais % (C28) : 'a%' ne doit rien rendre, abPct compris.
  assert wm.staff_user_search(m, 'a%') = '{"users": []}', wm.staff_user_search(m, 'a%')::text;
  r := wm.staff_user_search(m, 'a_');
  assert (select jsonb_agg(u ->> 'username') from jsonb_array_elements(r -> 'users') u) = '["a_Und"]', r::text;
  assert wm.staff_user_search(m, 'zzqq') = '{"users": []}', 'aucun';
  d := pg_temp.err(format('select wm.staff_user_search(%L, %L)', m, ' a '));
  assert d = pg_temp.e(400, 'invalid_request', 'Tape au moins 2 caractères'), d::text;
  assert pg_temp.err(format('select wm.staff_user_search(%L, null)', m)) = d, 'nul';
  d := pg_temp.err(format('select wm.staff_user_search(%L, %L)', pg_temp.player('SanSearchPl'), 'al'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  for i in 0..24 loop
    perform pg_temp.player(format('Pz%s', lpad(i::text, 2, '0')));
  end loop;
  r := wm.staff_user_search(m, 'pz');
  assert jsonb_array_length(r -> 'users') = 20 and r -> 'users' -> 0 ->> 'username' = 'Pz00' and r -> 'users' -> 19 ->> 'username' = 'Pz19',
    r::text;
end $$;

-- staff_user_detail : clés exactes, sanctions récentes d'abord, signalements, guilde, aucun e-mail ; compte supprimé.
do $$ declare a uuid := pg_temp.staff('admin'); m uuid := pg_temp.staff('moderator'); b uuid := pg_temp.player('SanDetail');
  c uuid := pg_temp.player('SanDetailC'); g uuid; i bigint; j bigint; r jsonb; d jsonb; begin
  i := pg_temp.sanction(a, b, 'warning');
  j := pg_temp.sanction(a, b, 'restriction', now() + interval '1 day');
  insert into public.reports (reporter_id, reported_user_id, reason) values (c, b, 'spam'), (b, c, 'cheating'), (m, b, 'cheating');
  insert into public.guilds (name, leader_id) values ('Guilde fiche', b) returning id into g;
  insert into public.guild_members (guild_id, user_id, role) values (g, b, 'leader');
  r := wm.staff_user_detail(m, b);
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k)
    = array['guild', 'reports_filed', 'reports_received', 'sanctions', 'staff_role', 'user'], r::text;
  assert r -> 'user' = jsonb_build_object('id', b, 'username', 'SanDetail', 'created_at', now(), 'last_seen_at', null, 'is_pro', false,
    'is_vip', false, 'balance', 0, 'is_public', true, 'deleted_at', null, 'auth_pending', false), r::text;
  assert r -> 'staff_role' = 'null' and r -> 'reports_received' = '2' and r -> 'reports_filed' = '1'
    and r -> 'guild' = jsonb_build_object('id', g, 'name', 'Guilde fiche'), r::text;
  assert r -> 'sanctions' = jsonb_build_array((select wm.sanction_json(s) from wm.sanctions s where id = j),
    (select wm.sanction_json(s) from wm.sanctions s where id = i)), r::text;
  assert strpos(r::text, '@') = 0, 'aucun e-mail';
  r := wm.staff_user_detail(a, m);
  assert r -> 'staff_role' = '"moderator"' and r -> 'guild' = 'null' and r -> 'sanctions' = '[]', r::text;
  insert into wm.deleted_accounts (user_id) values (c);
  r := wm.staff_user_detail(m, c);
  assert (r -> 'user' ->> 'deleted_at')::timestamptz = now() and (r -> 'user' ->> 'auth_pending')::boolean, r::text;
  update wm.deleted_accounts set auth_done_at = now() where user_id = c;
  assert not (wm.staff_user_detail(m, c) -> 'user' ->> 'auth_pending')::boolean, 'auth faite';
  d := pg_temp.err(format('select wm.staff_user_detail(%L, %L)', m, gen_random_uuid()));
  assert d = pg_temp.e(404, null, 'Joueur introuvable'), d::text;
  d := pg_temp.err(format('select wm.staff_user_detail(%L, %L)', pg_temp.player('SanDetailPl'), b));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
end $$;

-- lock_timeout avant le premier verrou ; levée : la sanction for update avant le profil ; lectures stables ; les six sont scannées.
do $$ declare s text := (select prosrc from pg_proc where oid = 'wm.admin_sanction_revoke(uuid, bigint, text, text)'::regprocedure);
  bad text; begin
  assert tests.lock_timeout_violations(array['admin_sanction', 'admin_sanction_revoke', 'admin_achievements_recheck']) is null,
    tests.lock_timeout_violations(array['admin_sanction', 'admin_sanction_revoke', 'admin_achievements_recheck']);
  assert strpos(s, 'from wm.sanctions') > 0 and strpos(s, 'from wm.sanctions') < strpos(s, 'for update')
    and strpos(s, 'for update') < strpos(s, 'wm.lock_user('), 'ordre des verrous de la levée';
  -- Compte supprimé relu sous le verrou du profil (la course elle-même : test de concurrence de la Task 8).
  select string_agg(f, ', ') into bad from unnest(array['admin_sanction', 'admin_achievements_recheck']) f,
    lateral (select prosrc src from pg_proc where oid = to_regproc('wm.' || f)) p
  where strpos(substr(src, strpos(src, 'wm.lock_user(')), 'from wm.deleted_accounts') = 0;
  assert bad is null, 'compte supprimé non relu sous verrou : ' || bad;
  select string_agg(f, ', ') into bad from unnest(array['admin_sanction', 'admin_sanction_revoke', 'admin_auth_sync',
    'admin_achievements_recheck', 'staff_user_search', 'staff_user_detail']) f where to_regproc('wm.' || f) is null;
  assert bad is null, 'absentes : ' || bad;
  select string_agg(f, ', ') into bad from unnest(array['staff_user_search(uuid, text)', 'staff_user_detail(uuid, uuid)']) f
  where (select provolatile from pg_proc where oid = ('wm.' || f)::regprocedure) <> 's';
  assert bad is null, 'non stable : ' || bad;
end $$;

-- ===== 2220 : signalements d'image, drapeaux, revue des signalements, messages privés d'une paire signalée, listes =====
-- Rejeu de 2220 : la migration passe une seconde fois sur la base déjà migrée.
\ir ../migrations/2220_wm_reports_review.sql

-- Carte dédiée : image_url propre (tests.image_card donne la même à toutes ses cartes, et card_avatar_clear retrouve les migrés par elle).
create function pg_temp.icard(p_title text) returns uuid language plpgsql as $$
declare c uuid := tests.image_card(p_title); begin
  update public.cards set image_url = image_url || '#' || id where id = c;
  return c;
end $$;

create function pg_temp.copy_of(p_user uuid, p_card uuid) returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  select p_user, c.id, c.wikipedia_title, c.rarity, c.atk, c.def from public.cards c where c.id = p_card returning id
$$;

create function pg_temp.audit(p_action text) returns setof wm.staff_actions language sql as $$
  select * from wm.staff_actions where action = p_action order by id
$$;

-- Signalement d'image : 9 puis 10e, 11e, avatars, retrait, refus, idempotence.
do $$ declare x uuid := pg_temp.icard('Img X'); y uuid := pg_temp.icard('Img Y'); a uuid := pg_temp.player('ImgA'); mig uuid := pg_temp.player('ImgMig');
  oth uuid := pg_temp.player('ImgOth'); ca uuid := pg_temp.copy_of(a, x); co uuid := pg_temp.copy_of(oth, y); u uuid; r jsonb; d jsonb; i int;
  n0 int := (select count(*) from wm.staff_actions where action = 'image_auto_hide'); begin
  update public.profiles set avatar_user_card_id = ca, avatar_url = (select image_url from public.cards where id = x) where id = a;
  update public.profiles set avatar_url = (select image_url from public.cards where id = x) where id = mig;
  update public.profiles set avatar_user_card_id = co, avatar_url = (select image_url from public.cards where id = y) where id = oth;
  assert wm.card_image_report_get(a, x) = '{"reported": false}', 'get avant';
  for i in 1..9 loop
    u := tests.make_user('ImgRep' || i);
    r := wm.card_image_report_set(u, x, true);
    assert r = '{"reported": true, "hidden": false}', r::text;
  end loop;
  assert not (select hide_image from public.cards where id = x), 'pas encore masquée';
  assert wm.card_image_report_get(u, x) = '{"reported": true}', 'get après';
  u := tests.make_user('ImgRep10');
  r := wm.card_image_report_set(u, x, true, 'img-10');
  assert r = '{"reported": true, "hidden": true}', r::text;
  assert (select hide_image from public.cards where id = x), 'masquée';
  assert (select count(*) from wm.staff_actions where action = 'image_auto_hide') = n0 + 1, 'une ligne d''audit';
  assert (select (staff_id is null, target_type, target_id, reason, payload) = (true, 'card', x::text, 'Seuil de signalements atteint',
    '{"reports": 10}'::jsonb) from wm.staff_actions where action = 'image_auto_hide' order by id desc limit 1), 'audit auto-masquage';
  assert (select avatar_user_card_id is null and avatar_url is null from public.profiles where id = a), 'avatar copie vidé';
  assert (select avatar_url is null from public.profiles where id = mig), 'avatar migré vidé';
  assert (select avatar_user_card_id = co and avatar_url is not null from public.profiles where id = oth), 'autre carte intacte';
  assert wm.card_image_report_set(u, x, true, 'img-10') = r, 'même idem, même corps';
  assert (select count(*) from wm.staff_actions where action = 'image_auto_hide') = n0 + 1, 'idem sans second effet';
  r := wm.card_image_report_set(tests.make_user('ImgRep11'), x, true);
  assert r = '{"reported": true, "hidden": true}' and (select count(*) from wm.staff_actions where action = 'image_auto_hide') = n0 + 1, 'un 11e';
  r := wm.card_image_report_set(u, x, false);
  assert r = '{"reported": false, "hidden": true}' and wm.card_image_report_get(u, x) = '{"reported": false}', 'retrait';
  assert (select count(*) from wm.card_image_reports where card_id = x) = 10, 'ligne partie';
  d := pg_temp.err(format('select wm.card_image_report_set(%L, %L, true)', a, gen_random_uuid()));
  assert d = pg_temp.e(404, null, 'Carte introuvable'), d::text;
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.card_image_report_set(%L, %L, true)', a, y));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), d::text;
  perform pg_temp.sanction(pg_temp.staff('admin'), a, 'ban');
  d := pg_temp.err(format('select wm.card_image_report_set(%L, %L, true)', a, y));
  assert d = pg_temp.e(403, null, 'Ton compte est temporairement restreint.') || '{"activity_blocked_until": null}', d::text;
end $$;

-- Drapeaux : démasquage (signalements effacés, compteur reparti de 0), nsfw vide les avatars, refus.
do $$ declare m uuid := pg_temp.staff('moderator'); p uuid := pg_temp.player('FlagPl'); x uuid := pg_temp.icard('Flag X'); a uuid := pg_temp.player('FlagA');
  ca uuid := pg_temp.copy_of(a, x); r jsonb; d jsonb; i int; u uuid; x0 wm.staff_actions; begin
  for i in 1..10 loop
    perform wm.card_image_report_set(tests.make_user('FlagRep' || i), x, true);
  end loop;
  assert (select hide_image from public.cards where id = x), 'masquée d''office';
  d := pg_temp.err(format('select wm.admin_card_flags(%L, %L, false, false, %L)', p, x, 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  d := pg_temp.err(format('select wm.admin_card_flags(%L, %L, false, false, %L)', m, x, '  '));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
  d := pg_temp.err(format('select wm.admin_card_flags(%L, %L, false, false, %L)', m, gen_random_uuid(), 'Motif de test'));
  assert d = pg_temp.e(404, null, 'Carte introuvable'), d::text;
  assert not exists (select from wm.staff_actions where action = 'card_flags'), 'refus sans audit';
  r := wm.admin_card_flags(m, x, false, false, 'Image conforme', 'flag-1');
  assert r = jsonb_build_object('card', jsonb_build_object('id', x, 'hide_image', false, 'nsfw_image', false),
    'cleared_avatars', 0, 'cleared_reports', 10), r::text;
  assert wm.admin_card_flags(m, x, false, false, 'Image conforme', 'flag-1') = r, 'même corps';
  assert (select count(*) from wm.staff_actions where action = 'card_flags') = 1, 'une seule ligne d''audit';
  select * into x0 from wm.staff_actions where action = 'card_flags';
  assert (x0.staff_id, x0.target_type, x0.target_id, x0.reason) = (m, 'card', x::text, 'Image conforme')
    and x0.payload = '{"before": {"hide_image": true, "nsfw_image": false}, "after": {"hide_image": false, "nsfw_image": false},
      "cleared_reports": 10}'::jsonb, x0.payload::text;
  assert not (select hide_image from public.cards where id = x) and not exists (select from wm.card_image_reports where card_id = x), 'état';
  -- Le compteur est reparti de 0 : neuf signalements ne masquent pas, le dixième oui.
  for i in 1..9 loop
    u := tests.make_user('FlagNew' || i);
    assert (wm.card_image_report_set(u, x, true) ->> 'hidden')::boolean = false, 'pas de boucle avant 10';
  end loop;
  assert (wm.card_image_report_set(tests.make_user('FlagNew10'), x, true) ->> 'hidden')::boolean, 're-masquée au 10e';
  r := wm.admin_card_flags(m, x, false, true, 'Image sensible');
  assert r -> 'cleared_avatars' = '0' and r -> 'cleared_reports' = '10' and (select nsfw_image from public.cards where id = x), r::text;
  update public.profiles set avatar_user_card_id = ca where id = a;
  r := wm.admin_card_flags(m, x, true, true, 'Retiré');
  assert r -> 'cleared_avatars' = '1' and (select avatar_user_card_id is null and avatar_url is null from public.profiles where id = a), r::text;
end $$;

-- Revue d'un signalement.
do $$ declare m uuid := pg_temp.staff('moderator'); p uuid := pg_temp.player('RevPl'); a uuid := pg_temp.player('RevA'); b uuid := pg_temp.player('RevB');
  rid uuid; r jsonb; d jsonb; begin
  insert into public.reports (reporter_id, reported_user_id, reason) values (a, b, 'spam') returning id into rid;
  d := pg_temp.err(format('select wm.admin_report_review(%L, %L, %L, %L)', p, rid, 'resolved', 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  d := pg_temp.err(format('select wm.admin_report_review(%L, %L, %L, %L)', m, rid, 'resolved', ' '));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
  d := pg_temp.err(format('select wm.admin_report_review(%L, %L, %L, %L)', m, rid, 'x', 'Motif de test'));
  assert d = pg_temp.e(400, 'invalid_request', 'Statut inconnu'), d::text;
  d := pg_temp.err(format('select wm.admin_report_review(%L, %L, %L, %L)', m, gen_random_uuid(), 'resolved', 'Motif de test'));
  assert d = pg_temp.e(404, null, 'Signalement introuvable'), d::text;
  assert not exists (select from wm.staff_actions where action = 'report_review') and not exists (select from wm.report_reviews where report_id = rid), 'refus sans écriture';
  r := wm.admin_report_review(m, rid, 'resolved', 'Traité', 'rev-1');
  assert r = '{"ok": true, "status": "resolved"}', r::text;
  assert wm.admin_report_review(m, rid, 'resolved', 'Traité', 'rev-1') = r and (select count(*) from wm.staff_actions where action = 'report_review') = 1, 'idem';
  r := wm.admin_report_review(m, rid, 'dismissed', 'Finalement non');
  assert r = '{"ok": true, "status": "dismissed"}', r::text;
  assert (select count(*) from wm.report_reviews where report_id = rid) = 1 and (select status from wm.report_reviews where report_id = rid) = 'dismissed', 'une revue';
  assert (select count(*) from wm.staff_actions where action = 'report_review' and target_id = rid::text) = 2, 'deux audits';
  assert (select payload from wm.staff_actions where action = 'report_review' order by id desc limit 1) = '{"status": "dismissed"}', 'payload';
  assert (select staff_action_id from wm.report_reviews where report_id = rid) = (select max(id) from wm.staff_actions where action = 'report_review'), 'audit rattaché';
end $$;

-- Messages privés d'une paire signalée.
do $$ declare m uuid := pg_temp.staff('moderator'); p uuid := pg_temp.player('DmPl'); a uuid := pg_temp.player('DmA'); b uuid := pg_temp.player('DmB');
  c uuid := pg_temp.player('DmC'); r jsonb; d jsonb; i int; mid uuid; ids uuid[]; tgt text; begin
  insert into public.friendships (requester_id, addressee_id, status) values (a, b, 'accepted'), (a, c, 'accepted');
  for i in 1..3 loop
    insert into public.chat_messages (sender_id, recipient_id, content, created_at)
    values (case when i = 2 then b else a end, case when i = 2 then a else b end, 'msg ' || i, now() - interval '1 hour' + i * interval '1 minute');
  end loop;
  insert into public.chat_messages (sender_id, recipient_id, content) values (a, c, 'hors paire') returning id into mid;
  d := pg_temp.err(format('select wm.admin_dm_thread(%L, %L, %L, %L)', m, a, b, 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Aucun signalement entre ces deux joueurs'), d::text;
  d := pg_temp.err(format('select wm.admin_dm_thread(%L, %L, %L, %L)', p, a, b, 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  d := pg_temp.err(format('select wm.admin_dm_thread(%L, %L, %L, %L)', m, a, b, ''));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
  assert not exists (select from wm.staff_actions where action = 'dm_read'), 'refus sans audit';
  insert into public.reports (reporter_id, reported_user_id, reason) values (b, a, 'inappropriate_content');
  r := wm.admin_dm_thread(m, a, b, 'Lecture du signalement');
  assert (select array_agg(e ->> 'content') from jsonb_array_elements(r -> 'messages') e) = array['msg 1', 'msg 2', 'msg 3'], r::text;
  assert (select array_agg(k order by k) from jsonb_object_keys(r -> 'messages' -> 0) k)
    = array['content', 'created_at', 'id', 'recipient_id', 'sender_id', 'sender_username'], 'clés';
  assert r -> 'messages' -> 0 ->> 'sender_username' = 'DmA' and r -> 'messages' -> 1 ->> 'sender_username' = 'DmB', 'pseudos';
  tgt := least(a, b)::text || ':' || greatest(a, b)::text;
  assert (select (target_type, target_id, payload) = ('dm_pair', tgt, '{"count": 3}'::jsonb) from wm.staff_actions where action = 'dm_read'), 'audit dm_read';
  r := wm.admin_dm_thread(m, b, a, 'Lecture inverse');
  assert (select count(*) from wm.staff_actions where action = 'dm_read' and target_id = tgt) = 2, 'même cible';
  insert into public.chat_messages (sender_id, recipient_id, content, created_at)
  select a, b, 'bulk ' || g, now() + g * interval '1 second' from generate_series(1, 98) g;
  r := wm.admin_dm_thread(m, a, b, 'Lecture bornée');
  assert jsonb_array_length(r -> 'messages') = 100 and r -> 'messages' -> 99 ->> 'content' = 'bulk 98', 'bornée à 100, ordre croissant';
  -- Suppression.
  select id into mid from public.chat_messages where content = 'msg 2';
  d := pg_temp.err(format('select wm.admin_dm_delete(%L, %L, %L)', p, mid, 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  d := pg_temp.err(format('select wm.admin_dm_delete(%L, %L, %L)', m, mid, ''));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
  r := wm.admin_dm_delete(m, mid, 'Insultes', 'dm-1');
  assert r = '{"ok": true}' and not exists (select from public.chat_messages where id = mid), r::text;
  assert wm.admin_dm_delete(m, mid, 'Insultes', 'dm-1') = r and (select count(*) from wm.staff_actions where action = 'dm_delete') = 1, 'idem';
  assert (select (target_type, target_id, payload) = ('dm', mid::text, jsonb_build_object('sender_id', b, 'recipient_id', a,
    'created_at', now() - interval '1 hour' + interval '2 minutes')) from wm.staff_actions where action = 'dm_delete'), 'audit sans content';
  d := pg_temp.err(format('select wm.admin_dm_delete(%L, %L, %L)', m, mid, 'Insultes'));
  assert d = pg_temp.e(404, null, 'Message introuvable'), d::text;
  select id into mid from public.chat_messages where content = 'hors paire';
  d := pg_temp.err(format('select wm.admin_dm_delete(%L, %L, %L)', m, mid, 'Insultes'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Aucun signalement entre ces deux joueurs'), d::text;
  assert exists (select from public.chat_messages where id = mid) and (select count(*) from wm.staff_actions where action = 'dm_delete') = 1, 'message gardé';
end $$;

-- Listes du staff.
do $$ declare m uuid := pg_temp.staff('moderator'); p uuid := pg_temp.player('LstPl'); a uuid := pg_temp.player('LstA'); b uuid := pg_temp.player('LstB');
  rev uuid; r jsonb; d jsonb; i int; x uuid := pg_temp.icard('Lst X'); y uuid := pg_temp.icard('Lst Y'); u uuid; begin
  insert into public.reports (reporter_id, reported_user_id, reason, details, created_at) values (a, b, 'cheating', 'détails', now() + interval '1 second') returning id into rev;
  perform wm.admin_report_review(m, rev, 'resolved', 'Traité');
  perform pg_temp.sanction(pg_temp.staff('admin'), b, 'warning');
  r := wm.staff_reports(m, 'reviewed');
  assert r -> 'reports' -> 0 ->> 'id' = rev::text, r::text;
  assert (select array_agg(k order by k) from jsonb_object_keys(r -> 'reports' -> 0) k)
    = array['active_sanctions', 'created_at', 'details', 'id', 'reason', 'reported', 'reporter', 'review'], 'clés';
  assert r -> 'reports' -> 0 -> 'reporter' = jsonb_build_object('id', a, 'username', 'LstA')
    and r -> 'reports' -> 0 -> 'reported' = jsonb_build_object('id', b, 'username', 'LstB') and r -> 'reports' -> 0 -> 'active_sanctions' = '1', r::text;
  assert (select array_agg(k order by k) from jsonb_object_keys(r -> 'reports' -> 0 -> 'review') k) = array['reviewed_at', 'reviewed_by_username', 'status']
    and r -> 'reports' -> 0 -> 'review' ->> 'status' = 'resolved', 'review';
  assert not exists (select from jsonb_array_elements(wm.staff_reports(m, 'open') -> 'reports') e where e ->> 'id' = rev::text), 'revu absent des ouverts';
  assert wm.staff_reports(m) -> 'reports' -> 0 -> 'review' = 'null', 'ouvert sans revue';
  for i in 1..51 loop
    u := tests.make_user('LstR' || i);
    insert into public.reports (reporter_id, reported_user_id, reason) values (u, b, 'spam');
  end loop;
  r := wm.staff_reports(m, 'open');
  assert jsonb_array_length(r -> 'reports') = 50 and (r ->> 'hasMore')::boolean, 'page de 50';
  assert (wm.staff_reports(m, 'open', -3) -> 'reports') = r -> 'reports', 'page bornée à 0';
  d := pg_temp.err(format('select wm.staff_reports(%L, %L)', m, 'x'));
  assert d = pg_temp.e(400, 'invalid_request', 'Statut inconnu'), d::text;
  d := pg_temp.err(format('select wm.staff_reports(%L)', p));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
  -- Images : X (10) avant Y (2).
  for i in 1..10 loop
    u := tests.make_user('LstI' || i);
    insert into wm.card_image_reports (card_id, user_id) values (x, u);
    if i <= 2 then insert into wm.card_image_reports (card_id, user_id) values (y, u); end if;
  end loop;
  r := wm.staff_image_reports(m);
  -- Les blocs précédents ont laissé d'autres cartes signalées : on ne regarde que X et Y, dans l'ordre rendu.
  assert (select array_agg(e ->> 'card_id') from jsonb_array_elements(r -> 'cards') e where e ->> 'card_id' in (x::text, y::text)) = array[x::text, y::text], r::text;
  assert (select array_agg(k order by k) from jsonb_object_keys(r -> 'cards' -> 0) k)
    = array['card_id', 'hide_image', 'image_url', 'last_reported_at', 'nsfw_image', 'reports', 'wikipedia_title'], 'clés';
  assert (select e -> 'reports' from jsonb_array_elements(r -> 'cards') e where e ->> 'card_id' = x::text) = '10'
    and (select e -> 'reports' from jsonb_array_elements(r -> 'cards') e where e ->> 'card_id' = y::text) = '2', 'comptes';
  d := pg_temp.err(format('select wm.staff_image_reports(%L)', p));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;
end $$;

-- lock_timeout, ordre des verrous, lectures stables, aides sous les verrous de l'appelant.
do $$ declare bad text; begin
  assert tests.lock_timeout_violations(array['card_image_report_set', 'admin_card_flags', 'admin_report_review', 'admin_dm_delete'],
    array['for update', 'wm.lock_user(']) is null, 'lock_timeout';
  assert strpos((select prosrc from pg_proc where oid = to_regproc('wm.card_avatar_clear')), 'lock_timeout') = 0, 'card_avatar_clear sans lock_timeout';
  select string_agg(f, ', ') into bad from unnest(array['card_image_report_get(uuid, uuid)', 'staff_reports(uuid, text, integer)',
    'staff_image_reports(uuid, integer)']) f where (select provolatile from pg_proc where oid = ('wm.' || f)::regprocedure) <> 's';
  assert bad is null, 'non stable : ' || bad;
end $$;

-- Scan de couverture : toute wm.admin_* (hors admin_reason) ouvre par staff_actor, exige un motif et écrit son audit, avec idempotence sauf
-- admin_dm_thread ; toute wm.staff_* de lecture ouvre par staff_actor ; aucune fonction ne modifie ni ne supprime l'audit (G8).
do $$ declare bad text; begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p
  where p.pronamespace = 'wm'::regnamespace and p.proname like 'admin\_%' and p.proname <> 'admin_reason'
    and (strpos(p.prosrc, 'wm.staff_actor(') = 0 or strpos(p.prosrc, 'wm.admin_reason(') = 0 or strpos(p.prosrc, 'wm.staff_log(') = 0
      or (p.proname <> 'admin_dm_thread' and (strpos(p.prosrc, 'wm.idem_claim(') = 0 or strpos(p.prosrc, 'wm.idem_store(') = 0)));
  assert bad is null, 'wm.admin_* sans staff_actor, motif, audit ou idempotence : ' || bad;
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p
  where p.pronamespace = 'wm'::regnamespace and p.proname like 'staff\_%' and p.proname not in ('staff_actor', 'staff_log', 'staff_me')
    and strpos(p.prosrc, 'wm.staff_actor(') = 0;
  assert bad is null, 'wm.staff_* sans staff_actor : ' || bad;
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p
  where p.pronamespace = 'wm'::regnamespace and p.prosrc ~* '(update|delete\s+from)\s+wm\.staff_actions';
  assert bad is null, 'audit modifié : ' || bad;
end $$;

-- Volatilité des lectures.
do $$ declare bad text; begin
  select string_agg(f, ', ') into bad from unnest(array['auth_state(uuid)', 'access_check(uuid)', 'staff_me(uuid)', 'sanction_json(wm.sanctions)']) f
  where (select provolatile from pg_proc where oid = ('wm.' || f)::regprocedure) <> 's';
  assert bad is null, 'non stable : ' || bad;
end $$;

select pg_temp.inv('fin de 37');
