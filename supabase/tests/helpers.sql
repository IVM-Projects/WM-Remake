-- Helpers des tests SQL (schéma tests, jamais en prod). Chargés seulement quand public.profiles existe.
select to_regclass('public.profiles') is not null as has_profiles \gset
\if :has_profiles

create schema if not exists tests;
-- login/logout/reset_role s'appellent aussi depuis ces rôles.
grant usage on schema tests to anon, authenticated, service_role;

-- security definer : utilisable quel que soit le rôle courant du test.
-- Métadonnées d'une vraie inscription : le trigger de profil (Task 3) les lit ; avant lui, l'insertion directe crée le profil.
-- Colonnes d'un compte confirmé telles que GoTrue les lit : instance nulle, aud/role, dates et chaînes de jeton non NULL (NULL → 500 au scan).
create or replace function tests.make_user(p_username text, p_balance int default 0) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_id || '@test.local', now(), now(), now(),
    jsonb_build_object('username', p_username, 'age_confirmed', true, 'terms_version', 'test'), '', '', '', '');
  insert into public.profiles (id, username, wikibidous_balance) values (v_id, p_username, p_balance)
  on conflict (id) do update set wikibidous_balance = excluded.wikibidous_balance;
  return v_id;
end $$;

-- Pas de security definer ci-dessous : SET ROLE y est interdit. Tout est local à la transaction.
create or replace function tests.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end $$;

create or replace function tests.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Claims remplacés aussi, comme PostgREST avec la clé secrète : pas de sub résiduel d'un login précédent.
create or replace function tests.as_service() returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

create or replace function tests.reset_role() returns void language plpgsql as $$
begin
  reset role;
end $$;

-- État complet d'un échange (P23, M4-7), comparé avant et après un échec : la ligne, les copies, étiquettes et profils de ses deux joueurs,
-- ses lignes de grand livre et ses notifications, les clés d'idempotence des deux joueurs, les invariants. Exige public.trades (M4a).
create or replace function tests.trade_snapshot(p_trade uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('trade', to_jsonb(t),
    'copies', (select coalesce(jsonb_agg(jsonb_build_object('id', uc.id, 'user_id', uc.user_id, 'count', uc.count, 'starred', uc.starred)
      order by uc.id), '[]') from public.user_cards uc where uc.user_id in (t.initiator_id, t.recipient_id)),
    'tags', (select coalesce(jsonb_agg(jsonb_build_array(ut.user_card_id, ut.tag_id) order by ut.user_card_id, ut.tag_id), '[]')
      from public.user_card_tags ut join public.user_cards uc on uc.id = ut.user_card_id where uc.user_id in (t.initiator_id, t.recipient_id)),
    'profiles', (select jsonb_agg(jsonb_build_object('id', p.id, 'avatar_user_card_id', p.avatar_user_card_id,
      'wikibidous_balance', p.wikibidous_balance) order by p.id) from public.profiles p where p.id in (t.initiator_id, t.recipient_id)),
    'ledger', (select count(*) from wm.wb_ledger where ref = 'trade:' || t.id),
    'notifications', (select count(*) from public.notifications where data ->> 'trade_id' = t.id::text),
    'idem', (select count(*) from wm.idempotency_keys where user_id in (t.initiator_id, t.recipient_id)),
    'invariants', wm.check_invariants())
  from public.trades t where t.id = p_trade
$$;

-- Faute injectée (P23, M4-7) : posée par un trigger de test filtré sur un échange, elle annule toute la transaction qui l'atteint.
create or replace function tests.boom() returns trigger language plpgsql as $$
begin
  raise exception 'erreur injectée' using errcode = 'XX000';
end $$;

\endif
