-- MIRROR : messages privés, vitrine, signalements, abonnements push (R§3.7, R§4.1, R§4.2, D§6.2, M4b-10, M4b-28). Idempotente.
-- authenticated lit les messages dont il est participant et marque lus ceux qu'il a reçus (read seul) ; rien d'autre côté client.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'report_reason' and typnamespace = 'public'::regnamespace) then
    create type public.report_reason as enum ('cheating', 'inappropriate_content', 'spam');
  end if;
end $$;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  content text not null check (char_length(content) <= 2000),
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- Un emplacement vide n'a pas de ligne (M4b-7).
create table if not exists public.showcase (
  user_id uuid not null references public.profiles (id) on delete cascade,
  position smallint not null check (position between 0 and 3),
  user_card_id uuid not null references public.user_cards (id) on delete cascade,
  primary key (user_id, position)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reported_user_id uuid not null references public.profiles (id) on delete cascade,
  reason public.report_reason not null,
  details text check (char_length(details) <= 500),
  created_at timestamptz not null default now(),
  unique (reporter_id, reported_user_id)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;
alter table public.showcase enable row level security;
alter table public.reports enable row level security;
alter table public.push_subscriptions enable row level security;

-- Table rase d'abord : la démo donne Dxtm par défaut aux nouvelles tables de public (verifications.md:12).
revoke all on table public.chat_messages, public.showcase, public.reports, public.push_subscriptions
  from public, anon, authenticated;
grant all on table public.chat_messages, public.showcase, public.reports, public.push_subscriptions to service_role;
-- Vitrine, signalements et abonnements : aucun droit client, tout passe par les routes (M4b-28).
grant select, update (read) on table public.chat_messages to authenticated;

-- Comme 0005 : une politique existante (même nom) n'est pas recréée.
do $$ declare p record; begin
  for p in select * from (values
    ('chat_messages', 'chat_messages_select_participant', 'select', '(select auth.uid()) in (sender_id, recipient_id)'),
    ('chat_messages', 'chat_messages_update_recipient', 'update', 'recipient_id = (select auth.uid())')  -- with check = using
  ) v (tbl, name, cmd, using_expr)
  where not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = v.name)
  loop
    execute format('create policy %I on public.%I for %s to authenticated using (%s)', p.name, p.tbl, p.cmd, p.using_expr);
  end loop;
end $$;
