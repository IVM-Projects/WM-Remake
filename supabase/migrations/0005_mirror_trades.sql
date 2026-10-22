-- MIRROR : échanges et amitiés (R§3.6, R§3.7, R§4.1, R§4.2, D§6.2, M4-1). Idempotente.
-- authenticated lit les échanges, leurs éléments et les amitiés dont il est participant ; aucune écriture client.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'trade_status' and typnamespace = 'public'::regnamespace) then
    create type public.trade_status as enum ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'countered');
  end if;
  if not exists (select 1 from pg_type where typname = 'friendship_status' and typnamespace = 'public'::regnamespace) then
    create type public.friendship_status as enum ('pending', 'accepted');
  end if;
end $$;

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  status public.trade_status not null default 'pending',
  initiator_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  initiator_wikibidous int not null default 0,
  recipient_wikibidous int not null default 0,
  parent_trade_id uuid references public.trades (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  expires_at timestamptz not null,
  check (initiator_id <> recipient_id)
);

create table if not exists public.trade_items (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.trades (id) on delete cascade,
  offered_by uuid not null references public.profiles (id) on delete cascade,
  user_card_id uuid not null,  -- sans clé étrangère : l'élément est l'historique, une copie défaussée ne l'efface pas (P2)
  card_id uuid not null references public.cards (id),
  snapshot_rarity public.rarity not null,
  is_shiny boolean not null default false
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status public.friendship_status not null default 'pending',
  created_at timestamptz not null default now(),
  check (requester_id <> addressee_id)
);

-- Une seule amitié par paire, quel que soit le sens de la demande (D:593).
create unique index if not exists friendships_pair_key
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

alter table public.trades enable row level security;
alter table public.trade_items enable row level security;
alter table public.friendships enable row level security;

-- Table rase d'abord : la démo donne Dxtm par défaut aux nouvelles tables de public (verifications.md:12).
revoke all on table public.trades, public.trade_items, public.friendships from public, anon, authenticated;
grant select on table public.trades, public.trade_items, public.friendships to authenticated;
grant all on table public.trades, public.trade_items, public.friendships to service_role;

-- Comme 0004 : une politique existante (même nom) n'est pas recréée.
do $$ declare p record; begin
  for p in select * from (values
    ('trades', 'trades_select_participant', '(select auth.uid()) in (initiator_id, recipient_id)'),
    ('trade_items', 'trade_items_select_participant',
      'exists (select from public.trades t where t.id = trade_id and (select auth.uid()) in (t.initiator_id, t.recipient_id))'),
    ('friendships', 'friendships_select_participant', '(select auth.uid()) in (requester_id, addressee_id)')
  ) v (tbl, name, using_expr)
  where not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = v.name)
  loop
    execute format('create policy %I on public.%I for select to authenticated using (%s)', p.name, p.tbl, p.using_expr);
  end loop;
end $$;
