-- MIRROR : tables du marché (R§3.5, R§4.2, D§6.2, M3-5). Idempotente.
-- Aucun index ici : ils arrivent en 1600, après wm_index.search_text et pg_trgm (P1).
-- authenticated lit toutes les enchères et toutes les mises, ses seules notifications ; aucune écriture client.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'auction_status' and typnamespace = 'public'::regnamespace) then
    create type public.auction_status as enum ('active', 'settled_sold', 'settled_unsold', 'cancelled');
  end if;
end $$;

create table if not exists public.auctions (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id) on delete cascade,
  card_id uuid not null references public.cards (id),
  user_card_id uuid,  -- sans clé étrangère : la copie quitte user_cards pour le séquestre (M3-7)
  snapshot_rarity public.rarity not null,
  snapshot_atk int,
  snapshot_def int,
  snapshot_search_document text,
  is_shiny boolean not null default false,
  base_amount int not null,
  listing_base_amount int not null,
  base_repriced_at timestamptz,
  current_bid int,
  current_bidder_id uuid references public.profiles (id) on delete set null,
  bids_count int not null default 0,
  final_price int,
  status public.auction_status not null default 'active',
  end_at timestamptz not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  winner_id uuid references public.profiles (id) on delete set null
);

create table if not exists public.auction_bids (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references public.auctions (id) on delete cascade,
  bidder_id uuid not null references public.profiles (id) on delete cascade,
  amount int not null,
  placed_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  data jsonb not null default '{}',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.auctions enable row level security;
alter table public.auction_bids enable row level security;
alter table public.notifications enable row level security;

-- Table rase d'abord : la démo donne Dxtm par défaut aux nouvelles tables de public (verifications.md:12).
revoke all on table public.auctions, public.auction_bids, public.notifications from public, anon, authenticated;
grant select on table public.auctions, public.auction_bids, public.notifications to authenticated;
grant all on table public.auctions, public.auction_bids, public.notifications to service_role;

-- Comme 0002 : une politique existante (même nom) n'est pas recréée.
do $$ declare p record; begin
  for p in select * from (values
    ('auctions', 'auctions_select', 'true'),
    ('auction_bids', 'auction_bids_select', 'true'),
    ('notifications', 'notifications_select_own', 'user_id = (select auth.uid())')
  ) v (tbl, name, using_expr)
  where not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = v.name)
  loop
    execute format('create policy %I on public.%I for select to authenticated using (%s)', p.name, p.tbl, p.using_expr);
  end loop;
end $$;
