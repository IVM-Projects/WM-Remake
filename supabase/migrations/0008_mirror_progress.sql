-- MIRROR : guildes et succès (R§3.8, R§3.10, R§4.2, D§6.2, D-C10, D-C20, M5b-4). Idempotente.
-- Aucun droit ni politique client sur les six tables de guilde : tout passe par les routes (précédent M4b-28).
-- Seuls achievements et user_achievements sont lisibles par PostgREST (R:267) ; claimed_at reste hors d'atteinte (R:515).

do $$ begin
  if not exists (select 1 from pg_type where typname = 'guild_role' and typnamespace = 'public'::regnamespace) then
    create type public.guild_role as enum ('leader', 'member');
  end if;
end $$;

-- leader_id passe à nul avec le profil du chef (D-C20) ; le nom n'est pas unique.
create table if not exists public.guilds (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  description text check (char_length(description) <= 280),
  leader_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.guild_members (
  guild_id uuid not null references public.guilds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.guild_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create table if not exists public.guild_wishlists (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references public.guilds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  card_id uuid not null references public.cards (id) on delete cascade,
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz
);

-- user_card_id sans clé étrangère : la copie source peut partir entière ou disparaître.
create table if not exists public.guild_donations (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references public.guilds (id) on delete cascade,
  wishlist_id uuid not null references public.guild_wishlists (id) on delete cascade,
  donor_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  user_card_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.guild_chat_messages (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references public.guilds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.guild_weekly_scores (
  week_start timestamptz not null,
  guild_id uuid not null references public.guilds (id) on delete cascade,
  score_battles bigint not null default 0,
  score_wb bigint not null default 0,
  total_score bigint generated always as (score_battles + score_wb) stored,
  primary key (week_start, guild_id)
);

create table if not exists public.achievements (
  id uuid primary key,
  title text not null,
  description text not null,
  wikibidous_reward int not null check (wikibidous_reward > 0),
  sort_order int not null,
  category text not null,
  threshold int not null
);

create table if not exists public.user_achievements (
  user_id uuid not null references public.profiles (id) on delete cascade,
  achievement_id uuid not null references public.achievements (id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  claimed_at timestamptz,
  primary key (user_id, achievement_id)
);

alter table public.guilds enable row level security;
alter table public.guild_members enable row level security;
alter table public.guild_wishlists enable row level security;
alter table public.guild_donations enable row level security;
alter table public.guild_chat_messages enable row level security;
alter table public.guild_weekly_scores enable row level security;
alter table public.achievements enable row level security;
alter table public.user_achievements enable row level security;

-- Table rase d'abord : la démo donne Dxtm par défaut aux nouvelles tables de public (verifications.md:12).
revoke all on table public.guilds, public.guild_members, public.guild_wishlists, public.guild_donations,
  public.guild_chat_messages, public.guild_weekly_scores, public.achievements, public.user_achievements
  from public, anon, authenticated;
grant all on table public.guilds, public.guild_members, public.guild_wishlists, public.guild_donations,
  public.guild_chat_messages, public.guild_weekly_scores, public.achievements, public.user_achievements to service_role;
grant select on table public.achievements, public.user_achievements to authenticated;

-- Comme 0006 : une politique existante (même nom) n'est pas recréée.
do $$ declare p record; begin
  for p in select * from (values
    ('achievements', 'achievements_select_all', 'select', 'true'),
    ('user_achievements', 'user_achievements_select_own', 'select', 'user_id = (select auth.uid())')
  ) v (tbl, name, cmd, using_expr)
  where not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = v.name)
  loop
    execute format('create policy %I on public.%I for %s to authenticated using (%s)', p.name, p.tbl, p.cmd, p.using_expr);
  end loop;
end $$;
