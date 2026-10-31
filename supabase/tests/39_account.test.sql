-- Suppression de compte (2250_wm_account_delete.sql) : report d'un bannissement à l'inscription d'un e-mail banni, garde de la pierre
-- tombale, account_auth_done, invariants pool_removed et deleted_account ; la Task 6b ajoute ses blocs (account_delete…).
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ne filtre que sur eux.
-- check_invariants est global : une violation voulue se fait dans une sous-transaction annulée (WMT00, 27_market.test.sql:278-285).

-- Rejeu de 2250 : la migration passe une seconde fois sur la base déjà migrée.
\ir ../migrations/2250_wm_account_delete.sql

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

-- Inscription GoTrue, gabarit de tests.make_user, sans l'insert du profil (le trigger le crée).
create function pg_temp.signup(p_username text, p_email text) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); begin
  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, now(), now(), now(),
    jsonb_build_object('username', p_username, 'age_confirmed', true, 'terms_version', 'test'), '', '', '', '');
  return v_id;
end $$;

select pg_temp.inv('début de 39');

-- Anti-évasion (G1) : l'empreinte est posée par insert (account_delete arrive en Task 6b).
do $$ declare old uuid := gen_random_uuid(); u uuid; v uuid; s wm.sanctions; a wm.staff_actions; begin
  insert into wm.banned_emails (email_hash, user_id) values (wm.email_hash('D@test.local'), old);
  u := pg_temp.signup('AccEvade', ' d@TEST.local ');
  assert exists (select from public.profiles where id = u and username = 'AccEvade'), 'profil';
  assert (select count(*) from wm.sanctions where user_id = u) = 1, 'une sanction';
  select * into s from wm.sanctions where user_id = u;
  assert s.kind = 'ban' and s.reason = 'Compte lié à un compte banni supprimé' and s.ends_at is null and s.revoked_at is null
    and s.starts_at <= now() and s.created_by is null, to_jsonb(s)::text;
  assert (select count(*) from wm.staff_actions where target_type = 'user' and target_id = u::text) = 1, 'une ligne d''audit';
  select * into a from wm.staff_actions where target_type = 'user' and target_id = u::text;
  assert a.staff_id is null and a.action = 'ban_carryover' and a.reason = 'Compte lié à un compte banni supprimé' and a.payload = '{}',
    to_jsonb(a)::text;
  v := pg_temp.signup('AccClean', 'autre@test.local');
  assert exists (select from public.profiles where id = v), 'profil propre';
  assert not exists (select from wm.sanctions where user_id = v), 'aucune sanction';
  assert not exists (select from wm.staff_actions where target_id = v::text), 'aucun audit';
end $$;

-- Garde de la pierre tombale (plan B de G1).
do $$ declare u uuid := tests.make_user('AccTomb'); v uuid := tests.make_user('AccPlain'); raised boolean := false; begin
  insert into wm.deleted_accounts (user_id) values (u);
  begin
    delete from auth.users where id = u;
  exception when sqlstate 'XX000' then
    raised := sqlerrm = format('pierre tombale protégée : %s', u);
  end;
  assert raised, 'XX000 attendu';
  assert exists (select from public.profiles where id = u) and exists (select from auth.users where id = u), 'pierre tombale gardée';
  perform set_config('wm.allow_tombstone_delete', 'on', true);
  delete from auth.users where id = u;
  assert not exists (select from public.profiles where id = u), 'supprimée sous réglage';
  perform set_config('wm.allow_tombstone_delete', 'off', true);
  delete from auth.users where id = v;
  assert not exists (select from public.profiles where id = v), 'profil ordinaire supprimé sans réglage';
end $$;

-- account_auth_done : pose auth_done_at une fois ; rejouée → inchangée.
do $$ declare u uuid := tests.make_user('AccAuth'); t timestamptz; begin
  insert into wm.deleted_accounts (user_id, deleted_at) values (u, now() - interval '1 hour');
  assert wm.account_auth_done(u) = '{"ok": true}'::jsonb, 'réponse';
  select auth_done_at into t from wm.deleted_accounts where user_id = u;
  assert t = now(), 'auth_done_at posé';
  update wm.deleted_accounts set auth_done_at = now() - interval '1 minute' where user_id = u;
  assert wm.account_auth_done(u) = '{"ok": true}'::jsonb, 'réponse rejouée';
  assert (select auth_done_at from wm.deleted_accounts where user_id = u) = now() - interval '1 minute', 'inchangé';
end $$;

-- Invariants neufs : pool_removed, deleted_account 'cards', 'friend', 'guild' (sous-transaction annulée).
do $$ declare c uuid := tests.image_card('Acc Pool'); u uuid := tests.make_user('AccInv1'); w uuid := tests.make_user('AccInv2');
  g uuid; d jsonb; begin
  perform wm.pool_add(c, 'R');
  perform pg_temp.inv('pool');
  begin
    insert into wm.card_removals (card_id, reason) values (c, 'test');
    insert into wm.deleted_accounts (user_id) values (u);
    insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
    values (u, c, 'Acc Pool', 'R', 10, 10);
    insert into public.friendships (requester_id, addressee_id, status) values (w, u, 'accepted');
    insert into public.guilds (name, leader_id) values ('AccInvGuild', w) returning id into g;
    insert into public.guild_members (guild_id, user_id, role) values (g, w, 'leader'), (g, u, 'member');
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d @> jsonb_build_array(jsonb_build_object('check', 'pool_removed', 'card_id', c)), d::text;
  assert (select jsonb_agg(e ->> 'problem' order by e ->> 'problem') from jsonb_array_elements(d) e
    where e ->> 'check' = 'deleted_account' and e ->> 'user_id' = u::text) = '["cards", "friend", "guild"]'::jsonb, d::text;
  assert (select count(*) from jsonb_array_elements(d) e where e ->> 'check' in ('pool_removed', 'deleted_account')) = 4, d::text;
end $$;

select pg_temp.inv('fin de 39');
