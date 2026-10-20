-- MIRROR : les deux RPC publiques de l'original (R§3.1, D§7.2) et la lecture anon du catalogue (R§3.4, D§7.4). Idempotente.
-- Jamais appliquée en option A : là, sa propre sync_profile_packs reste en place et wm.apply_regen s'aligne dessus.
-- plpgsql et non sql : le corps n'est résolu qu'à l'appel, wm.apply_regen n'arrive qu'en 1100.

grant select on table public.cards to anon;
do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'cards' and policyname = 'cards_select_anon') then
    create policy cards_select_anon on public.cards for select to anon using (true);
  end if;
end $$;

-- Appelée par /pulls à chaque visite ; 42501 → 403 par PostgREST pour un autre joueur.
create or replace function public.sync_profile_packs(user_id uuid)
returns table (username text, avatar_url text, is_pro boolean, is_vip boolean, pack_cap int, packs_remaining int,
  packs_last_regen_at timestamptz, wikibidous_balance int, next_regen_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  if user_id is distinct from auth.uid() then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;
  perform from public.profiles where id = user_id for update;
  p := wm.apply_regen(user_id);
  return query select p.username, p.avatar_url, p.is_pro, p.is_vip, p.pack_cap, p.packs_remaining, p.packs_last_regen_at,
    p.wikibidous_balance, wm.next_regen_at(p) where p.id is not null;
end $$;

create or replace function public.get_my_profile()
returns setof public.profiles language plpgsql security definer set search_path = '' as $$
begin
  perform from public.profiles where id = auth.uid() for update;
  return query select * from wm.apply_regen(auth.uid()) p where p.id is not null;
end $$;

revoke execute on function public.sync_profile_packs(uuid), public.get_my_profile() from public, anon;
grant execute on function public.sync_profile_packs(uuid), public.get_my_profile() to authenticated;
