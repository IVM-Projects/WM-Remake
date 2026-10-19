-- MIRROR : tables du cœur de public (R§4.2, D§6.2). Idempotente. RLS et droits anon/authenticated : 0002 (Task 6).
-- Contraintes en ligne laissées aux noms par défaut de PG, les plus probables dans le schéma d'origine.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'rarity' and typnamespace = 'public'::regnamespace) then
    create type public.rarity as enum ('C', 'PC', 'R', 'SR', 'UR', 'L');
  end if;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  avatar_url text,
  avatar_user_card_id uuid,
  bio text check (char_length(bio) <= 280),
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  is_pro boolean not null default false,
  is_vip boolean not null default false,
  pack_cap int not null default 10,
  packs_remaining int not null default 1,  -- dotation de départ (D§7.1)
  packs_last_regen_at timestamptz,
  wikibidous_balance int not null default 0 check (wikibidous_balance >= 0),
  activity_blocked_until timestamptz,
  packs_blocked_until timestamptz
);
create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  wikipedia_title text not null,
  wikipedia_url text not null,
  lang text not null default 'fr',
  rarity public.rarity not null,
  atk int not null,
  def int not null,
  q_score numeric(6, 2),
  pageviews int not null default 0,
  pageviews_refreshed_at timestamptz,
  qscore_refreshed_at timestamptz,
  category text,
  summary text,
  image_url text,
  hide_image boolean not null default false,
  nsfw_image boolean not null default false,
  created_at timestamptz not null default now(),
  unique (lang, wikipedia_title)
) with (fillfactor = 90);

create table if not exists public.user_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  card_id uuid not null references public.cards (id),
  count int not null default 1 check (count >= 1),
  starred boolean not null default false,
  is_shiny boolean not null default false,
  snapshot_title text not null,
  snapshot_rarity public.rarity not null,
  snapshot_category text,
  snapshot_atk int not null,
  snapshot_def int not null,
  obtained_at timestamptz not null default now()
);

-- Ajoutée après coup : profiles et user_cards se référencent mutuellement.
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'profiles_avatar_user_card_id_fkey' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_avatar_user_card_id_fkey
      foreign key (avatar_user_card_id) references public.user_cards (id) on delete set null;
  end if;
end $$;

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 48),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.user_card_tags (
  user_card_id uuid references public.user_cards (id) on delete cascade,
  tag_id uuid references public.tags (id) on delete cascade,
  primary key (user_card_id, tag_id)
);

create table if not exists public.wishlist_items (
  user_id uuid references public.profiles (id) on delete cascade,
  card_id uuid references public.cards (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

-- Index de clés étrangères minimaux ; les index de performance arrivent avec leur domaine (D§9.4).
create index if not exists user_cards_user_id_idx on public.user_cards (user_id);
create index if not exists user_cards_card_id_idx on public.user_cards (card_id);
create index if not exists user_card_tags_tag_id_idx on public.user_card_tags (tag_id);
create index if not exists tags_user_id_idx on public.tags (user_id);

-- Projets Supabase créés après le 30 mai 2026 : aucun droit par défaut, tout est accordé explicitement.
grant all on table public.profiles, public.cards, public.user_cards, public.tags, public.user_card_tags,
  public.wishlist_items to service_role;
