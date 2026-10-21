-- Schéma wm (1000_wm_core.sql) : erreurs, acteur, portefeuille, idempotence, santé, privilèges.

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql est annulé.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

-- raise_err : message = chaîne française, detail = {status, code, error, message, …extra}.
do $$ declare d text; m text; begin
  perform wm.raise_err(409, 'bid_too_low', 'Mise trop basse (minimum 110 wikibidous)', '{"min":110}');
  assert false, 'raise_err n''a rien levé';
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail, m = message_text;
  assert d::jsonb = '{"status":409,"code":"bid_too_low","error":"Mise trop basse (minimum 110 wikibidous)","message":"Mise trop basse (minimum 110 wikibidous)","min":110}'::jsonb, d;
  assert m = 'Mise trop basse (minimum 110 wikibidous)', m;
end $$;

-- code null retiré ; null explicite de l'extra conservé.
do $$ declare d jsonb := pg_temp.err($q$select wm.raise_err(403, null, 'x', '{"until":null}')$q$); begin
  assert d = '{"status":403,"error":"x","message":"x","until":null}'::jsonb, d::text;
end $$;

do $$ begin assert (select value from wm.config where key = 'maintenance') = 'false'::jsonb; end $$;

-- actor : maintenance, profil inconnu.
do $$ declare u uuid := tests.make_user('Act1'); d jsonb; begin
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.actor(%L)', u));
  assert d = '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.","message":"Maintenance en cours, reviens dans quelques minutes."}'::jsonb, d::text;
  update wm.config set value = 'false' where key = 'maintenance';
  d := pg_temp.err(format('select wm.actor(%L)', gen_random_uuid()));
  assert d = '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}'::jsonb, d::text;
end $$;

-- actor : drapeaux, staff.
do $$ declare u uuid := tests.make_user('Act2'); begin
  assert wm.actor(u) = '{"is_pro":false,"is_vip":false,"is_staff":false,"staff_role":null}'::jsonb, wm.actor(u)::text;
  update public.profiles set is_pro = true where id = u;
  insert into wm.staff (user_id, role) values (u, 'admin');
  assert wm.actor(u) = '{"is_pro":true,"is_vip":false,"is_staff":true,"staff_role":"admin"}'::jsonb, wm.actor(u)::text;
end $$;

-- actor : sanctions. Avertissement, révoquée, expirée ou future → passe ; ban actif → 403 exact.
do $$ declare u uuid := tests.make_user('Act3'); d jsonb; begin
  insert into wm.sanctions (user_id, kind) values (u, 'warning');
  insert into wm.sanctions (user_id, kind, revoked_at) values (u, 'ban', now());
  insert into wm.sanctions (user_id, kind, starts_at, ends_at) values (u, 'suspension', now() - interval '2 days', now() - interval '1 day');
  insert into wm.sanctions (user_id, kind, starts_at) values (u, 'restriction', now() + interval '1 day');
  assert pg_temp.err(format('select wm.actor(%L)', u)) is null, 'sanction inactive bloquante';
  insert into wm.sanctions (user_id, kind) values (u, 'ban');
  d := pg_temp.err(format('select wm.actor(%L)', u));
  assert d = '{"status":403,"error":"Ton compte est temporairement restreint.","message":"Ton compte est temporairement restreint.","activity_blocked_until":null}'::jsonb, d::text;
end $$;

-- actor : sanction datée → sa fin dans le détail ; activity_blocked_until futur → 403 avec la date.
do $$ declare u uuid := tests.make_user('Act4'); v uuid := tests.make_user('Act5'); t timestamptz := now() + interval '1 hour'; d jsonb; begin
  insert into wm.sanctions (user_id, kind, ends_at) values (u, 'suspension', t);
  d := pg_temp.err(format('select wm.actor(%L)', u));
  assert d ->> 'status' = '403' and (d ->> 'activity_blocked_until')::timestamptz = t, d::text;
  update public.profiles set activity_blocked_until = now() - interval '1 minute' where id = v;
  assert pg_temp.err(format('select wm.actor(%L)', v)) is null, 'blocage expiré bloquant';
  update public.profiles set activity_blocked_until = t where id = v;
  d := pg_temp.err(format('select wm.actor(%L)', v));
  assert d ->> 'error' = 'Ton compte est temporairement restreint.' and (d ->> 'activity_blocked_until')::timestamptz = t, d::text;
end $$;

-- actor : packs_blocked_until ne bloque que le périmètre packs.
do $$ declare u uuid := tests.make_user('Act6'); t timestamptz := now() + interval '1 hour'; d jsonb; begin
  update public.profiles set packs_blocked_until = t where id = u;
  assert pg_temp.err(format('select wm.actor(%L)', u)) is null, 'packs_blocked_until bloque hors packs';
  d := pg_temp.err(format('select wm.actor(%L, %L)', u, 'packs'));
  assert d ->> 'status' = '403' and d ->> 'message' = 'Ton compte est temporairement restreint.'
    and (d ->> 'packs_blocked_until')::timestamptz = t and not d ? 'code', d::text;
end $$;

-- wallet_apply : ouverture, crédit, rejeu, solde insuffisant, invariants.
do $$ declare u uuid := tests.make_user('Wal1', 100); d jsonb; begin
  assert wm.wallet_apply(u, 5, 'test', 'r1') = 105;
  assert wm.wallet_apply(u, 5, 'test', 'r1') = 105, 'rejeu crédité deux fois';
  assert (select wikibidous_balance from public.profiles where id = u) = 105;
  assert (select count(*) from wm.wb_ledger where user_id = u and ref = 'r1') = 1;
  assert (select array_agg(format('%s:%s:%s:%s', reason, ref, delta, balance_after) order by id) from wm.wb_ledger where user_id = u)
    = array['opening:opening:100:100', 'test:r1:5:105'], 'écritures inattendues';
  d := pg_temp.err(format('select wm.wallet_apply(%L, -200, %L, %L)', u, 'test', 'r2'));
  assert d = '{"status":409,"code":"insufficient_balance","error":"Solde insuffisant","message":"Solde insuffisant"}'::jsonb, d::text;
  assert (select wikibidous_balance from public.profiles where id = u) = 105, 'solde modifié par un débit refusé';
  assert not exists (select from wm.wb_ledger where user_id = u and ref = 'r2'), 'écriture d''un débit refusé conservée';
  assert wm.wallet_apply(u, -105, 'test', 'r3') = 0, 'débit du solde exact refusé';
  assert wm.check_invariants() = '[]'::jsonb, wm.check_invariants()::text;
end $$;

-- wallet_apply : premier appel refusé → pas d'écriture d'ouverture non plus ; joueur inconnu → 401.
do $$ declare u uuid := tests.make_user('Wal2', 10); d jsonb; begin
  d := pg_temp.err(format('select wm.wallet_apply(%L, -11, %L, %L)', u, 'test', 'x'));
  assert d ->> 'code' = 'insufficient_balance', d::text;
  assert not exists (select from wm.wb_ledger where user_id = u), 'ouverture conservée après un débit refusé';
  d := pg_temp.err(format('select wm.wallet_apply(%L, 1, %L, %L)', gen_random_uuid(), 'test', 'x'));
  assert d ->> 'status' = '401' and d ->> 'code' = 'unauthorized', d::text;
end $$;

-- check_invariants : solde modifié hors wallet_apply → ledger_balance.
do $$ declare u uuid := tests.make_user('Wal3', 50); v jsonb; begin
  perform wm.wallet_apply(u, 1, 'test', 'r1');
  update public.profiles set wikibidous_balance = 1 where id = u;
  v := wm.check_invariants();
  assert v @> jsonb_build_array(jsonb_build_object('check', 'ledger_balance', 'user_id', u, 'balance', 1, 'ledger_sum', 51)), v::text;
end $$;

-- idem_claim / idem_store.
do $$ declare u uuid := tests.make_user('Idem1'); d jsonb; begin
  assert wm.idem_claim(u, 'k1') is null, 'première réclamation non nulle';
  assert wm.idem_store(u, 'k1', '{"ok":1}') = '{"ok":1}'::jsonb;
  assert wm.idem_claim(u, 'k1') = '{"ok":1}'::jsonb, 'réponse stockée non rejouée';
  assert wm.idem_claim(u, null) is null and wm.idem_store(u, null, '{"ok":2}') = '{"ok":2}'::jsonb;
  assert wm.idem_claim(u, repeat('a', 128)) is null, 'clé de 128 caractères refusée';
  d := pg_temp.err(format('select wm.idem_claim(%L, %L)', u, repeat('a', 129)));
  assert d = '{"status":400,"code":"invalid_request","error":"Idempotency-Key invalide (1 à 128 caractères).","message":"Idempotency-Key invalide (1 à 128 caractères)."}'::jsonb, d::text;
  assert pg_temp.err(format('select wm.idem_claim(%L, %L)', u, '')) ->> 'status' = '400', 'clé vide acceptée';
end $$;

-- Sans pg_cron (banc, CI) : settle_lag_s et overdue_s présents et JSON null (P13).
do $$ declare h jsonb := wm.health(); begin
  assert h - 'now' - 'settle_lag_s' - 'overdue_s' = '{"ok":true,"db":"ok"}'::jsonb and (h ->> 'now')::timestamptz is not null
    and h -> 'settle_lag_s' = 'null'::jsonb and h -> 'overdue_s' = 'null'::jsonb, h::text;
end $$;

-- Index additif sur profiles.avatar_user_card_id (D§9.4) et index du grand livre.
do $$ begin
  assert (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'profiles_avatar_user_card_id_idx')
    like '%(avatar_user_card_id) WHERE (avatar_user_card_id IS NOT NULL)', 'index avatar absent';
  assert (select indexdef from pg_indexes where schemaname = 'wm' and tablename = 'wb_ledger' and indexdef like '%(user_id, created_at DESC)') is not null,
    'index (user_id, created_at desc) absent';
end $$;

-- Chaque fonction wm : security definer, search_path vide, EXECUTE à service_role seul. Aucun droit sur les tables.
do $$ declare bad text; begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p
  where p.pronamespace = 'wm'::regnamespace
    and (not p.prosecdef or p.proconfig is distinct from array['search_path=""']
         or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
         or exists (select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)
         or not has_function_privilege('service_role', p.oid, 'execute'));
  assert bad is null, format('fonctions mal verrouillées : %s', bad);
  select string_agg(format('%s %s', c.relname, a.privilege_type), ', ') into bad
  from pg_class c, aclexplode(c.relacl) a
  where c.relnamespace = 'wm'::regnamespace and a.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid);
  assert bad is null, format('droits sur les tables wm : %s', bad);
  assert not has_schema_privilege('anon', 'wm', 'usage') and not has_schema_privilege('authenticated', 'wm', 'usage')
    and has_schema_privilege('service_role', 'wm', 'usage');
end $$;

do $$ declare u uuid := tests.make_user('Priv1'); begin
  perform tests.login(u);
  begin perform wm.health(); assert false, 'authenticated appelle wm.health()';
  exception when insufficient_privilege then null; end;
  perform tests.logout();
  begin perform wm.health(); assert false, 'anon appelle wm.health()';
  exception when insufficient_privilege then null; end;
  perform tests.as_service();
  assert (wm.health() ->> 'ok')::boolean;
  perform tests.reset_role();
end $$;
