-- Stub local du strict nécessaire de Supabase (rôles, extensions, auth) pour le banc de tests. Jamais en prod.
-- Sauté si le schéma auth existe déjà (vraie base Supabase).
select to_regnamespace('auth') is null as bootstrap_needed \gset
\if :bootstrap_needed

-- Les rôles sont globaux au cluster : créés sous garde, la base est recréée à chaque run mais pas le cluster.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  -- Mot de passe de test seulement : le banc de contrat y connecte PostgREST (postgres:17 de la CI en scram).
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}',
  raw_app_meta_data jsonb not null default '{}',
  banned_until timestamptz,
  created_at timestamptz not null default now()
);

-- Claims posés par PostgREST (ou tests.login) ; '' ou absent → null.
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable
as $$ select (auth.jwt() ->> 'sub')::uuid $$;
create or replace function auth.role() returns text language sql stable
as $$ select auth.jwt() ->> 'role' $$;

-- Défauts Supabase : usage des schémas (auth pour auth.uid() dans les politiques RLS), aucun droit sur les tables.
grant usage on schema public, extensions, auth to anon, authenticated, service_role;

\endif
