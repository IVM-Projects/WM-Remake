-- Stub local du strict nécessaire de Supabase (rôles, extensions, schéma auth vide) pour le banc. Jamais en prod.
-- Le contenu du schéma auth (users, uid(), jwt()…) vient de `auth migrate` du vrai GoTrue, lancé par db-test.sh.
-- Sauté si auth.users existe déjà (vraie base Supabase).
select to_regclass('auth.users') is null as bootstrap_needed \gset
\if :bootstrap_needed

-- Les rôles sont globaux au cluster : créés sous garde, la base est recréée à chaque run mais pas le cluster.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  -- Mots de passe de test seulement : le banc y connecte PostgREST et GoTrue (postgres:17 de la CI en scram).
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator';
  end if;
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login createrole noinherit password 'auth';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- GoTrue migre son schéma lui-même ; il lui faut le schéma, le droit de créer dans la base et son search_path.
create schema if not exists auth authorization supabase_auth_admin;
do $$ begin execute format('grant create on database %I to supabase_auth_admin', current_database()); end $$;
alter role supabase_auth_admin set search_path = auth;

-- Défauts Supabase : usage des schémas (auth pour auth.uid() dans les politiques RLS), aucun droit sur les tables.
grant usage on schema public, extensions, auth to anon, authenticated, service_role;

\endif
