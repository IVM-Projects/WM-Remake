-- ADDITIVE : friendOwners de l'overlay du catalogue (M4b-21, P21 a) — amis possesseurs de chaque carte, au plus list_caps.friend_owners.
-- Idempotente, sans écriture de données. Calculé ici, dans l'overlay par joueur, jamais dans la page partagée en cache (M2-14).

-- Même signature et mêmes clés qu'en 1520. friendOwners : {card_id: [{id, username}]}, amis acceptés des deux sens de la ligne (profil privé
-- compris), par lower(username), id ; une carte sans ami possesseur n'a pas de clé.
create or replace function wm.cards_overlay(p_uid uuid, p_card_ids uuid[])
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'ownedCardIds', (select coalesce(jsonb_agg(p.id order by p.o), '[]') from unnest(p_card_ids) with ordinality p (id, o)
      where exists (select from public.user_cards uc where uc.card_id = p.id and uc.user_id = p_uid)),
    'wishlistCardIds', (select coalesce(jsonb_agg(p.id order by p.o), '[]') from unnest(p_card_ids) with ordinality p (id, o)
      where exists (select from public.wishlist_items w where w.user_id = p_uid and w.card_id = p.id)),
    -- Une ligne par paire (friendships_pair_key) : union all sans doublon. exists : plusieurs copies d'un ami comptent une fois.
    -- Arrêt précoce (B14) : amis triés une fois ; par carte, unnest … with ordinality sort déjà dans l'ordre, sans tri, et le limit arrête
    -- les sondes de user_cards_card_user_idx au dernier ami retenu.
    -- shortcut: une page qu'aucun ami ne possède coûte cartes × amis sondes (≈ 74 ms à 1 000 amis au banc), passer par les possesseurs de la carte quand ils sont moins nombreux que les amis (M8)
    'friendOwners', (with s (ids, names) as materialized (
        select array_agg(p.id order by lower(p.username), p.id), array_agg(p.username order by lower(p.username), p.id)
        from (select addressee_id id from public.friendships where requester_id = p_uid and status = 'accepted'
              union all select requester_id from public.friendships where addressee_id = p_uid and status = 'accepted') f
        join public.profiles p on p.id = f.id)
      select coalesce(jsonb_object_agg(c.id, o.v), '{}') from unnest(p_card_ids) c (id), s
      cross join lateral (select jsonb_agg(jsonb_build_object('id', a.id, 'username', a.username) order by a.r) v
        from (select f.id, f.username, f.r from unnest(s.ids, s.names) with ordinality f (id, username, r)
              where exists (select from public.user_cards uc where uc.card_id = c.id and uc.user_id = f.id)
              order by f.r
              limit (select (value ->> 'friend_owners')::int from wm.config where key = 'list_caps')) a) o
      where o.v is not null))
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
