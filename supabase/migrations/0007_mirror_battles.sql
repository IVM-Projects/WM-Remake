-- MIRROR : batailles (R§3.9, R§4.1, R§4.2, D§6.2, M5a-10, M5a-11). Idempotente.
-- Aucun droit ni politique client : game_state passe par les routes, qui taisent le deck adverse (précédent M4b-28).

do $$ begin
  if not exists (select 1 from pg_type where typname = 'battle_status' and typnamespace = 'public'::regnamespace) then
    create type public.battle_status as enum ('pending', 'deck_selection', 'generating_quizzes', 'active', 'completed', 'cancelled');
  end if;
end $$;

create table if not exists public.battles (
  id uuid primary key default gen_random_uuid(),
  challenger_id uuid not null references public.profiles (id) on delete cascade,
  opponent_id uuid not null references public.profiles (id) on delete cascade,
  winner_id uuid references public.profiles (id) on delete cascade,
  status public.battle_status not null default 'pending',
  game_state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (challenger_id <> opponent_id)
);

-- card_ids sans clé étrangère (tableau) : ids catalogue figés au submit_deck (C4).
create table if not exists public.battle_decks (
  battle_id uuid not null references public.battles (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  card_ids uuid[] not null check (cardinality(card_ids) = 3),
  created_at timestamptz not null default now(),
  primary key (battle_id, user_id)
);

alter table public.battles enable row level security;
alter table public.battle_decks enable row level security;

-- Table rase d'abord : la démo donne Dxtm par défaut aux nouvelles tables de public (verifications.md:12).
revoke all on table public.battles, public.battle_decks from public, anon, authenticated;
grant all on table public.battles, public.battle_decks to service_role;
