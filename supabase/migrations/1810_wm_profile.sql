-- ADDITIVE : profil et vitrine (R§3.7, M4b-2, M4b-5, M4b-6, M4b-7, M4b-8, B2, P21 c) — lecture entière ou réduite d'un profil, bio,
-- visibilité, avatar d'une copie à image, vitrine de 4 emplacements, collection d'un profil privé ouverte à ses amis. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Profil entier (B2), ou réduit sans bio (M4b-5).
create or replace function wm.profile_json(p public.profiles, p_full boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url, 'is_public', p.is_public, 'created_at', p.created_at)
    || case when p_full then jsonb_build_object('bio', p.bio) else '{}' end
$$;

-- Profil par pseudo (M4b-5) : entier pour soi, un ami ou un profil public. friendship : la ligne de la paire, quel qu'en soit le statut.
create or replace function wm.profile_get(p_uid uuid, p_username text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.profiles;
  v_friend boolean;
begin
  select * into p from public.profiles where lower(username) = lower(p_username);
  if not found then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  v_friend := wm.are_friends(p_uid, p.id);
  return jsonb_build_object('profile', wm.profile_json(p, p.id = p_uid or v_friend or p.is_public), 'isOwn', p.id = p_uid, 'isFriend', v_friend,
    'friendship', (select jsonb_build_object('id', f.id, 'status', f.status, 'requester_id', f.requester_id) from public.friendships f
      where least(f.requester_id, f.addressee_id) = least(p_uid, p.id) and greatest(f.requester_id, f.addressee_id) = greatest(p_uid, p.id)));
end $$;

-- Son profil (M4b-6, M4b-8). La copie de l'avatar est relue sous le verrou du profil, que trade_action et la défausse tiennent avant de la
-- déplacer (M4b-2). avatar_url s'écrit avec l'id, retrait compris : le trigger de 1800 ne voit pas un profil migré sans copie.
create or replace function wm.profile_update(p_uid uuid, p_username text, p_bio text default null, p_is_public boolean default null,
  p_avatar_user_card_id uuid default null, p_avatar_set boolean default false, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_target uuid;
  v_card public.cards;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  select id into v_target from public.profiles where lower(username) = lower(p_username);
  if not found then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  if v_target <> p_uid then
    perform wm.raise_err(403, 'FORBIDDEN', 'Tu ne peux modifier que ton profil');
  end if;
  if char_length(p_bio) > 280 then
    perform wm.raise_err(400, 'invalid_request', 'La bio fait au plus 280 caractères');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  if p_avatar_set and p_avatar_user_card_id is not null then
    select k.* into v_card from public.user_cards uc join public.cards k on k.id = uc.card_id
    where uc.id = p_avatar_user_card_id and uc.user_id = p_uid;
    if not found then
      perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
    elsif v_card.image_url is null or v_card.hide_image then
      perform wm.raise_err(400, 'invalid_request', 'Cette carte n''a pas d''image utilisable en avatar');
    elsif v_card.nsfw_image then
      perform wm.raise_err(400, 'invalid_request', 'Une image sensible ne peut pas servir d''avatar');
    end if;
  end if;
  update public.profiles set bio = case when p_bio is null then bio else nullif(p_bio, '') end, is_public = coalesce(p_is_public, is_public),
    avatar_user_card_id = case when p_avatar_set then p_avatar_user_card_id else avatar_user_card_id end,
    avatar_url = case when p_avatar_set then v_card.image_url else avatar_url end
  where id = p_uid;
  return wm.idem_store(p_uid, p_idem, wm.profile_get(p_uid, p_username));
end $$;

-- Redéfinie de 1300, signature et réponse inchangées : un profil privé s'ouvre aussi à ses amis (P21 c).
-- Collection d'un joueur par pseudo : items réduits (ni étiquettes ni favoris), rarityCounts en cartes uniques sur toute la collection.
create or replace function wm.profile_collection(p_uid uuid, p_username text, p_page int default 0, p_q text default null,
  p_stats boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  r jsonb;
begin
  select * into p from public.profiles where lower(username) = lower(p_username);
  if not found then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  if not p.is_public and p.id is distinct from p_uid and not wm.are_friends(p_uid, p.id) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Ce profil est privé');
  end if;
  r := wm.my_collection(p.id, p_page, 50, 'rarity', p_q);
  return jsonb_build_object('collection', (select coalesce(jsonb_agg(jsonb_build_object('id', x -> 'id', 'card', x -> 'card', 'count', x -> 'count',
      'is_shiny', x -> 'is_shiny', 'snapshot_rarity', x -> 'snapshot_rarity') order by o), '[]')
      from jsonb_array_elements(r -> 'collection') with ordinality e (x, o)), 'total', r -> 'total')
    || case when p_stats then jsonb_build_object('rarityCounts', (select jsonb_object_agg(k, (select count(distinct uc.card_id)
         from public.user_cards uc where uc.user_id = p.id and uc.snapshot_rarity = k)) from unnest(enum_range(null::public.rarity)) k))
       else '{}' end;
end $$;

-- Emplacements de p_owner triés (B2) ; la copie a la forme des éléments de profile_collection, son card celle de my_collection.
create or replace function wm.showcase_json(p_owner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('showcase', coalesce(jsonb_agg(jsonb_build_object('position', s.position, 'user_card_id', s.user_card_id,
      'user_card', jsonb_build_object('id', uc.id, 'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title,
          'rarity', c.rarity, 'category', c.category, 'atk', c.atk, 'def', c.def, 'image_url', c.image_url, 'hide_image', c.hide_image,
          'nsfw_image', c.nsfw_image, 'wikipedia_url', c.wikipedia_url, 'description', c.category, 'summary', c.summary),
        'count', uc.count, 'is_shiny', uc.is_shiny, 'snapshot_rarity', uc.snapshot_rarity)) order by s.position), '[]'))
  from public.showcase s join public.user_cards uc on uc.id = s.user_card_id join public.cards c on c.id = uc.card_id
  where s.user_id = p_owner
$$;

-- GET /api/showcase, et la réponse de ses écritures (M4b-8) : galleries en constante (M4b-7).
create or replace function wm.my_showcase(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select wm.showcase_json(p_uid) || '{"galleries": []}'
$$;

-- Vitrine d'un joueur par pseudo : un profil privé n'est lisible que par lui-même et ses amis (M4b-5).
create or replace function wm.profile_showcase(p_uid uuid, p_username text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where lower(username) = lower(p_username);
  if not found then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  if not p.is_public and p.id is distinct from p_uid and not wm.are_friends(p_uid, p.id) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Ce profil est privé');
  end if;
  return wm.showcase_json(p.id);
end $$;

-- Pose une copie dans un emplacement, qu'elle remplace (M4b-7) ; la copie est relue sous le verrou du profil (M4b-2).
create or replace function wm.showcase_put(p_uid uuid, p_position int, p_user_card_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_position is null or p_position not between 0 and 3 then
    perform wm.raise_err(400, 'invalid_request', 'Emplacement de vitrine inconnu (0 à 3)');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  if not exists (select from public.user_cards where id = p_user_card_id and user_id = p_uid) then
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  if exists (select from public.showcase where user_id = p_uid and user_card_id = p_user_card_id and position <> p_position) then
    perform wm.raise_err(400, 'invalid_request', 'Cette carte est déjà dans ta vitrine');
  end if;
  insert into public.showcase (user_id, position, user_card_id) values (p_uid, p_position, p_user_card_id)
  on conflict (user_id, position) do update set user_card_id = excluded.user_card_id;
  return wm.idem_store(p_uid, p_idem, wm.my_showcase(p_uid));
end $$;

-- Vide un emplacement ; un emplacement déjà vide n'est pas une erreur.
create or replace function wm.showcase_delete(p_uid uuid, p_position int, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_position is null or p_position not between 0 and 3 then
    perform wm.raise_err(400, 'invalid_request', 'Emplacement de vitrine inconnu (0 à 3)');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  delete from public.showcase where user_id = p_uid and position = p_position;
  return wm.idem_store(p_uid, p_idem, wm.my_showcase(p_uid));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
