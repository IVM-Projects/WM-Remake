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
  where p.pronamespace = 'wm'::regnamespace
    and (strpos(lower(p.prosrc), 'update wm.staff_actions') > 0 or strpos(lower(p.prosrc), 'delete from wm.staff_actions') > 0);
  assert bad is null, 'audit modifié : ' || bad;
end $$;

-- Volatilité des lectures.
do $$ declare bad text; begin
  select string_agg(f, ', ') into bad from unnest(array['auth_state(uuid)', 'access_check(uuid)', 'staff_me(uuid)', 'sanction_json(wm.sanctions)']) f
  where (select provolatile from pg_proc where oid = ('wm.' || f)::regprocedure) <> 's';
  assert bad is null, 'non stable : ' || bad;
end $$;

select pg_temp.inv('fin de 37');
