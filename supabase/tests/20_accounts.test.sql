-- Comptes (1100_wm_accounts.sql) : trigger d'inscription, pseudos, renommage, préférences, vérification humaine, lock_user.

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql est annulé.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

-- Inscription telle que GoTrue l'écrit : le trigger crée le profil ou lève son erreur.
create function pg_temp.signup(p_meta jsonb) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid(); begin
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', v || '@test.local', p_meta);
  return v;
end $$;

-- Trigger : profil de départ (1 paquet, 0 WB) et une ligne dans chaque table wm.
do $$ declare u uuid := pg_temp.signup('{"username":"alice","age_confirmed":true,"terms_version":"t"}'); begin
  assert (select format('%s %s %s', username, packs_remaining, wikibidous_balance) from public.profiles where id = u) = 'alice 1 0';
  assert exists (select from wm.user_state where user_id = u) and exists (select from wm.user_stats where user_id = u)
    and (select hide_sensitive from wm.user_prefs where user_id = u), 'lignes wm absentes';
end $$;

-- Trigger : casse gardée.
do $$ declare u uuid := pg_temp.signup('{"username":"BoB.Mix-2_x","age_confirmed":true,"terms_version":"t"}'); begin
  assert (select username from public.profiles where id = u) = 'BoB.Mix-2_x';
end $$;

-- Trigger : consentement manquant (âge absent ou faux, conditions vides) → consent_required, rien n'est créé.
do $$ declare m text; d jsonb; begin
  foreach m in array array['{"username":"nocon","terms_version":"t"}', '{"username":"nocon","age_confirmed":false,"terms_version":"t"}',
                           '{"username":"nocon","age_confirmed":true,"terms_version":""}', '{"username":"nocon","age_confirmed":true}'] loop
    d := pg_temp.err(format('select pg_temp.signup(%L)', m));
    assert d = '{"status":400,"code":"consent_required","error":"Confirme avoir au moins 18 ans et accepte les conditions.","message":"Confirme avoir au moins 18 ans et accepte les conditions."}'::jsonb, m || ' → ' || coalesce(d::text, 'accepté');
  end loop;
end $$;

-- Trigger : pseudo invalide, réservé, pris → messages exacts.
do $$ declare d jsonb; begin
  d := pg_temp.err($q$select pg_temp.signup('{"username":"a b","age_confirmed":true,"terms_version":"t"}')$q$);
  assert d = '{"status":400,"code":"username_invalid","error":"Pseudo invalide (3 à 24 caractères)","message":"Pseudo invalide (3 à 24 caractères)"}'::jsonb, d::text;
  d := pg_temp.err($q$select pg_temp.signup('{"age_confirmed":true,"terms_version":"t"}')$q$);
  assert d ->> 'code' = 'username_invalid', 'pseudo absent : ' || coalesce(d::text, 'accepté');
  d := pg_temp.err($q$select pg_temp.signup('{"username":"Admin","age_confirmed":true,"terms_version":"t"}')$q$);
  assert d = '{"status":400,"code":"username_reserved","error":"Ce pseudo est réservé","message":"Ce pseudo est réservé"}'::jsonb, d::text;
  d := pg_temp.err($q$select pg_temp.signup('{"username":"ALICE","age_confirmed":true,"terms_version":"t"}')$q$);
  assert d = '{"status":409,"code":"username_taken","error":"Ce pseudo est déjà pris","message":"Ce pseudo est déjà pris"}'::jsonb, d::text;
end $$;

-- username_problem : règle C28 (ASCII, 3 à 24), réservés sur lower(), unicité sur lower().
do $$ begin
  assert not exists (select from unnest(array['ab', repeat('a', 25), 'a b', 'é', 'аlice', '', E'alice\n']) x
                     where wm.username_problem(x) is distinct from 'invalid'), 'pseudo invalide accepté';
  assert wm.username_problem(null) = 'invalid';
  assert wm.username_problem('Admin') = 'reserved' and wm.username_problem('MODO') = 'reserved';
  assert wm.username_problem('ALICE') = 'taken';
  assert wm.username_problem('bob.le-2_x') is null and wm.username_problem(repeat('a', 24)) is null and wm.username_problem('abc') is null;
end $$;

do $$ begin
  assert wm.username_available('bob.le-2_x') = '{"available":true}'::jsonb;
  assert wm.username_available('Admin') = '{"available":false,"reason":"reserved","error":"Ce pseudo est réservé"}'::jsonb, wm.username_available('Admin')::text;
  assert wm.username_available('alice') = '{"available":false,"reason":"taken","error":"Ce pseudo est déjà pris"}'::jsonb;
  assert wm.username_available('ab') = '{"available":false,"reason":"invalid","error":"Pseudo invalide (3 à 24 caractères)"}'::jsonb;
end $$;

-- Course : la vérification passe (username_problem neutralisé, remplacement annulé avec le sous-bloc), l'index unique tranche.
do $$ declare u uuid := tests.make_user('Race1'); d jsonb; e jsonb; begin
  begin
    create or replace function wm.username_problem(p_username text, p_uid uuid default null) returns text language sql as 'select null::text';
    d := pg_temp.err($q$select pg_temp.signup('{"username":"ALICE","age_confirmed":true,"terms_version":"t"}')$q$);
    e := pg_temp.err(format('select wm.change_username(%L, %L)', u, 'ALICE'));
    raise sqlstate 'WMT01';
  exception when sqlstate 'WMT01' then null;
  end;
  assert d ->> 'code' = 'username_taken' and d ->> 'status' = '409', 'inscription : ' || coalesce(d::text, 'acceptée');
  assert e ->> 'code' = 'username_taken' and e ->> 'status' = '409', 'renommage : ' || coalesce(e::text, 'accepté');
  assert wm.username_problem('ALICE') = 'taken', 'username_problem non restauré';
end $$;

-- change_username : premier changement libre, puis un tous les 30 jours ; next_change_at = username_changed_at + 30 jours.
do $$ declare u uuid := tests.make_user('Ren1'); r jsonb; d jsonb; t timestamptz; begin
  r := wm.change_username(u, 'Ren1b');
  select username_changed_at + interval '30 days' into t from wm.user_state where user_id = u;
  assert r ->> 'username' = 'Ren1b' and (r ->> 'next_change_at')::timestamptz = t, r::text;
  assert (select username from public.profiles where id = u) = 'Ren1b';
  update wm.user_state set username_changed_at = now() - interval '29 days 23 hours' where user_id = u;
  d := pg_temp.err(format('select wm.change_username(%L, %L)', u, 'Ren1c'));
  assert d - 'next_change_at' = '{"status":409,"code":"username_change_too_soon","error":"Un seul changement de pseudo tous les 30 jours.","message":"Un seul changement de pseudo tous les 30 jours."}'::jsonb
    and (d ->> 'next_change_at')::timestamptz = now() + interval '1 hour', d::text;
  update wm.user_state set username_changed_at = now() - interval '30 days' where user_id = u;
  r := wm.change_username(u, 'Ren1c');
  assert r ->> 'username' = 'Ren1c' and (select username from public.profiles where id = u) = 'Ren1c', r::text;
end $$;

-- change_username : mêmes refus que le trigger.
do $$ declare u uuid := tests.make_user('Ren2'); begin
  assert pg_temp.err(format('select wm.change_username(%L, %L)', u, 'ab')) ->> 'code' = 'username_invalid';
  assert pg_temp.err(format('select wm.change_username(%L, %L)', u, 'Support')) ->> 'code' = 'username_reserved';
  assert pg_temp.err(format('select wm.change_username(%L, %L)', u, 'Alice')) ->> 'code' = 'username_taken';
end $$;

-- change_username : changement de casse de son propre pseudo accepté et compté ; même pseudo exact → sans effet.
do $$ declare u uuid := tests.make_user('casey'); r jsonb; begin
  r := wm.change_username(u, 'casey');
  assert r = '{"username":"casey","next_change_at":null}'::jsonb, r::text;
  assert (select username_changed_at from wm.user_state where user_id = u) is null, 'même pseudo compté comme changement';
  r := wm.change_username(u, 'Casey');
  assert r ->> 'username' = 'Casey' and (select username from public.profiles where id = u) = 'Casey', r::text;
  assert (select username_changed_at from wm.user_state where user_id = u) = now(), 'changement de casse non compté';
  assert wm.username_problem('CASEY') = 'taken' and wm.username_problem('CASEY', u) is null;
end $$;

-- Préférences : null = inchangé, is_public dans profiles.
do $$ declare u uuid := tests.make_user('Pref1'); begin
  assert wm.get_prefs(u) = '{"sounds":true,"hide_sensitive":true,"is_public":true}'::jsonb, wm.get_prefs(u)::text;
  assert wm.set_prefs(u, null, false, null) = '{"sounds":true,"hide_sensitive":false,"is_public":true}'::jsonb;
  assert wm.set_prefs(u, false, null, false) = '{"sounds":false,"hide_sensitive":false,"is_public":false}'::jsonb;
  assert (select not is_public from public.profiles where id = u) and wm.get_prefs(u) ->> 'sounds' = 'false';
  assert pg_temp.err(format('select wm.get_prefs(%L)', gen_random_uuid())) ->> 'code' = 'unauthorized';
end $$;

-- Vérification humaine : 12 h, rafale d'ouvertures remise à zéro.
do $$ declare u uuid := tests.make_user('Hum1'); begin
  update wm.user_state set open_window_count = 30 where user_id = u;
  assert wm.set_human_verified(u) = '{"ok":true}'::jsonb;
  assert (select human_verified_until between now() + interval '11 hours 59 minutes' and now() + interval '12 hours 1 minute'
            and open_window_count = 0 from wm.user_state where user_id = u), 'vérification humaine mal enregistrée';
end $$;

-- lock_user : profil sans lignes wm (inséré sans trigger, profil migré) → lignes créées ; profil inconnu → 401.
do $$ declare u uuid; p public.profiles; begin
  alter table auth.users disable trigger wm_on_auth_user_created;
  u := tests.make_user('Mig1');
  alter table auth.users enable trigger wm_on_auth_user_created;
  assert not exists (select from wm.user_state where user_id = u), 'trigger actif malgré disable';
  p := wm.lock_user(u);
  assert p.id = u and p.username = 'Mig1';
  assert exists (select from wm.user_state where user_id = u) and exists (select from wm.user_stats where user_id = u)
    and exists (select from wm.user_prefs where user_id = u), 'lignes wm non créées';
  assert pg_temp.err(format('select wm.lock_user(%L)', gen_random_uuid())) ->> 'code' = 'unauthorized';
end $$;

-- Clés de configuration.
do $$ begin
  assert (select value from wm.config where key = 'username_change_days') = '30'::jsonb;
  assert (select value from wm.config where key = 'human_check_ttl_h') = '12'::jsonb;
  assert (select value from wm.config where key = 'reserved_usernames') = '["admin","administrateur","administrator","staff","moderateur","moderator","modo","support","wikimasters","wikicartes","system","systeme"]'::jsonb;
  assert not exists (select from wm.config where key in ('reserved_usernames', 'username_change_days', 'human_check_ttl_h') and note is null);
end $$;
