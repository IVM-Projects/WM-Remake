-- MIRROR : RLS et droits de la surface PostgREST directe de l'original (R§3.3, R§7.1, D§5.3, D§6.3). Idempotente.
-- anon : rien. authenticated : lit le catalogue et ses lignes, n'écrit que starred, ses étiquettes, liaisons et souhaits.
-- Jamais d'écriture client sur les soldes, count, packs_*, snapshot_*, obtained_at, ni insert/delete de user_cards.

alter table public.profiles enable row level security;
alter table public.cards enable row level security;
alter table public.user_cards enable row level security;
alter table public.tags enable row level security;
alter table public.user_card_tags enable row level security;
alter table public.wishlist_items enable row level security;

grant select on table public.profiles, public.cards to authenticated;
grant select, update (starred) on table public.user_cards to authenticated;
grant select, insert, update (name, color), delete on table public.tags to authenticated;
grant select, insert, delete on table public.user_card_tags, public.wishlist_items to authenticated;

-- (select auth.uid()) : évalué une fois par instruction. Une politique existante (même nom) n'est pas recréée.
do $$ declare
  own text := 'user_id = (select auth.uid())';
  -- user_card_tags : la copie ET l'étiquette doivent être à l'utilisateur.
  own_link text := 'exists (select from public.user_cards uc where uc.id = user_card_tags.user_card_id'
    ' and uc.user_id = (select auth.uid())) and exists (select from public.tags t'
    ' where t.id = user_card_tags.tag_id and t.user_id = (select auth.uid()))';
  p record;
begin
  for p in select * from (values
    ('profiles', 'profiles_select_own', 'select', 'id = (select auth.uid())', null),
    ('cards', 'cards_select', 'select', 'true', null),
    ('user_cards', 'user_cards_select_own', 'select', own, null),
    ('user_cards', 'user_cards_update_own', 'update', own, null),  -- with check = using ; seul starred est accordé
    ('tags', 'tags_all_own', 'all', own, null),                    -- select, insert, update, delete ; with check = using
    ('user_card_tags', 'user_card_tags_select_own', 'select', own_link, null),
    ('user_card_tags', 'user_card_tags_insert_own', 'insert', null, own_link),
    ('user_card_tags', 'user_card_tags_delete_own', 'delete', own_link, null),
    ('wishlist_items', 'wishlist_items_select_own', 'select', own, null),
    ('wishlist_items', 'wishlist_items_insert_own', 'insert', null, own),
    ('wishlist_items', 'wishlist_items_delete_own', 'delete', own, null)
  ) v (tbl, name, cmd, using_expr, check_expr)
  where not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = v.name)
  loop
    execute format('create policy %I on public.%I for %s to authenticated', p.name, p.tbl, p.cmd)
      || coalesce(' using (' || p.using_expr || ')', '') || coalesce(' with check (' || p.check_expr || ')', '');
  end loop;
end $$;
