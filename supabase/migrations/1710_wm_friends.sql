-- ADDITIVE : amitiés (D§7.9, R§3.7, M4-11, M4-12, P4, P6, P12) — demande, acceptation, refus qui supprime, retrait qui annule les échanges
-- en attente, tout accepter, liste, recherche par préfixe indexée, collection et souhaits ouverts aux amis. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Recherche par préfixe (M4-11) ; option A : CONCURRENTLY par le runbook.
create index if not exists profiles_username_prefix_idx on public.profiles (lower(username) text_pattern_ops);

-- Une ligne accepted sur la paire, dans un sens ou dans l'autre (index de paire de 0005).
create or replace function wm.are_friends(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select from public.friendships where least(requester_id, addressee_id) = least(p_a, p_b)
    and greatest(requester_id, addressee_id) = greatest(p_a, p_b) and status = 'accepted')
$$;

create or replace function wm.friendship_json(f public.friendships)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(f) || jsonb_build_object(
    'requester', (select jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url) from public.profiles p where p.id = f.requester_id),
    'addressee', (select jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url) from public.profiles p where p.id = f.addressee_id))
$$;

-- data des notifications d'amitié (M4-12) : l'auteur de l'action, sans texte, pour l'autre participant. Une instruction triée (P28).
create or replace function wm.notify_friend(p_friendship_ids uuid[], p_type text, p_actor uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_name text := (select username from public.profiles where id = p_actor);
  n int;
begin
  insert into public.notifications (user_id, type, data)
  select case when f.requester_id = p_actor then f.addressee_id else f.requester_id end user_id, p_type,
    jsonb_build_object('friendship_id', f.id, 'user_id', p_actor, 'username', v_name)
  from public.friendships f where f.id = any (p_friendship_ids) order by user_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- 409 FRIEND_LIMIT si un joueur dépasserait friend_limit (null : désactivée, M4-11). p_uids : une entrée par ami gagné, un joueur y figure
-- autant de fois qu'il gagne d'amis (tout accepter compte le lot entier).
create or replace function wm.friend_limit_check(p_uids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v jsonb := (select value from wm.config where key = 'friend_limit');
begin
  if v <> 'null'::jsonb and exists (select from unnest(p_uids) u group by u having count(*)
      + (select count(*) from public.friendships f where f.status = 'accepted' and u in (f.requester_id, f.addressee_id)) > v::int) then
    perform wm.raise_err(409, 'FRIEND_LIMIT', format('Limite d''amis atteinte (%s)', v));
  end if;
end $$;

-- Demande (M4-11) : les deux profils tenus (P4) sérialisent deux demandes croisées, qui sinon finiraient en 23505 sur l'index de paire.
-- Une demande vers qui m'a déjà demandé reste un 409 : pas d'acceptation implicite.
create or replace function wm.friend_request(p_uid uuid, p_addressee_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  f public.friendships;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_addressee_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas t''ajouter toi-même en ami');
  end if;
  if not exists (select from public.profiles where id = p_addressee_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_users(array[p_uid, p_addressee_id]);
  select * into f from public.friendships where least(requester_id, addressee_id) = least(p_uid, p_addressee_id)
    and greatest(requester_id, addressee_id) = greatest(p_uid, p_addressee_id);
  if f.status = 'accepted' then
    perform wm.raise_err(409, 'ALREADY_FRIENDS', 'Vous êtes déjà amis');
  elsif found then
    perform wm.raise_err(409, 'REQUEST_PENDING', 'Une demande d''ami est déjà en attente');
  end if;
  perform wm.friend_limit_check(array[p_uid]);
  insert into public.friendships (requester_id, addressee_id) values (p_uid, p_addressee_id) returning * into f;
  perform wm.notify_friend(array[f.id], 'friend_request', p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('friendship', wm.friendship_json(f)));
end $$;

-- Accepter ou refuser une demande reçue. Seule la ligne d'amitié est verrouillée, jamais les profils (P4). Un refus supprime (M4-11).
create or replace function wm.friend_action(p_uid uuid, p_friendship_id uuid, p_action text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  f public.friendships;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_action is distinct from 'accept' and p_action is distinct from 'decline' then
    perform wm.raise_err(400, 'invalid_request', 'Action inconnue');
  end if;
  perform set_config('lock_timeout', '2s', true);
  select * into f from public.friendships where id = p_friendship_id and p_uid in (requester_id, addressee_id) for update;
  if not found then
    perform wm.raise_err(404, null, 'Demande d''ami introuvable');
  end if;
  if f.status = 'accepted' then
    perform wm.raise_err(409, 'ALREADY_FRIENDS', 'Vous êtes déjà amis');
  end if;
  if p_uid <> f.addressee_id then
    perform wm.raise_err(403, 'FORBIDDEN', case p_action when 'accept' then 'Seul le destinataire peut accepter cette demande'
      else 'Seul le destinataire peut refuser cette demande' end);
  end if;
  if p_action = 'decline' then
    delete from public.friendships where id = f.id;
    return wm.idem_store(p_uid, p_idem, '{"ok": true}');
  end if;
  -- shortcut: sans verrou de profil, des acceptations parallèles dépassent la limite (limite + N − 1) ; avant de l'activer, prendre
  -- wm.lock_users des joueurs après les lignes d'amitié.
  perform wm.friend_limit_check(array[f.requester_id, f.addressee_id]);
  update public.friendships set status = 'accepted' where id = f.id returning * into f;
  perform wm.notify_friend(array[f.id], 'friend_accepted', p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('friendship', wm.friendship_json(f)));
end $$;

-- Retrait d'un ami, ou d'une demande en attente par l'un ou l'autre. Les échanges en attente et non échus entre les deux passent à cancelled
-- dans la même transaction ; un échu reste au cron (P3). Ni notification ni profil verrouillé (P4, P6) : amitié, puis lignes d'échange,
-- sans cycle avec trade_action (échange, profils, lecture de l'amitié sans verrou).
create or replace function wm.friend_remove(p_uid uuid, p_friendship_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  f public.friendships;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  select * into f from public.friendships where id = p_friendship_id and p_uid in (requester_id, addressee_id) for update;
  if not found then
    perform wm.raise_err(404, null, 'Demande d''ami introuvable');
  end if;
  update public.trades set status = 'cancelled', closed_at = clock_timestamp(), updated_at = clock_timestamp()
  where status = 'pending' and expires_at > clock_timestamp()
    and ((initiator_id = f.requester_id and recipient_id = f.addressee_id) or (initiator_id = f.addressee_id and recipient_id = f.requester_id));
  delete from public.friendships where id = f.id;
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Toutes mes demandes reçues en attente, lignes prises par id (P4) ; la limite vaut pour le lot entier.
create or replace function wm.friend_accept_all(p_uid uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_ids uuid[];
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  v_ids := array(select id from public.friendships where addressee_id = p_uid and status = 'pending' order by id for update);
  -- shortcut: sans verrou de profil, des acceptations parallèles dépassent la limite (limite + N − 1) ; avant de l'activer, prendre
  -- wm.lock_users des joueurs après les lignes d'amitié.
  perform wm.friend_limit_check(array(select x from public.friendships f, unnest(array[f.requester_id, f.addressee_id]) x
    where f.id = any (v_ids)));
  update public.friendships set status = 'accepted' where id = any (v_ids);
  perform wm.notify_friend(v_ids, 'friend_accepted', p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('accepted', cardinality(v_ids)));
end $$;

-- Amis et demandes dans les deux sens, toutes (M4-16), les plus récentes d'abord.
create or replace function wm.friends_list(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('friendships', coalesce(jsonb_agg(wm.friendship_json(f) order by f.created_at desc, f.id), '[]'))
  from public.friendships f where p_uid in (f.requester_id, f.addressee_id)
$$;

-- Préfixe de lower(btrim(q)), \ % _ échappés (échappement par défaut de LIKE), soi-même exclu (P12). Motif en littéral, comme
-- collection_filter : un paramètre d'un plan générique ne se sert pas de l'index de préfixe.
create or replace function wm.friend_search(p_uid uuid, p_q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := lower(btrim(p_q));
  r jsonb;
begin
  if coalesce(char_length(v_q), 0) < 2 then
    perform wm.raise_err(400, 'invalid_request', 'La recherche demande au moins 2 caractères');
  end if;
  execute format('select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''username'', username, ''avatar_url'', avatar_url)
      order by lower(username), id), ''[]'') from (select id, username, avatar_url from public.profiles
      where lower(username) like %L and id <> %L order by lower(username), id limit %s) x',
    replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%', p_uid,
    (select (value ->> 'friend_search')::int from wm.config where key = 'list_caps'))
  into r;
  return jsonb_build_object('users', r);
end $$;

-- Clause where (ET) des copies lues par my_collection et my_collection_stats, valeurs en littéraux : le plan ne garde que les filtres posés.
-- La collection d'un autre : profil public ou ami ; sa liste de souhaits : ami (S:36).
create or replace function wm.collection_filter(p_uid uuid, p_q text, p_rarity public.rarity[], p_tag_id uuid, p_untagged boolean,
  p_wishlisted_by uuid, p_owned_by uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_q text := extensions.unaccent('extensions.unaccent', lower(nullif(btrim(p_q), '')));
begin
  if coalesce(p_owned_by, p_uid) is distinct from p_uid
     and not coalesce((select is_public from public.profiles where id = p_owned_by), false) and not wm.are_friends(p_uid, p_owned_by) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Cette collection est privée');
  end if;
  if coalesce(p_wishlisted_by, p_uid) is distinct from p_uid and not wm.are_friends(p_uid, p_wishlisted_by) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour voir sa liste de souhaits');
  end if;
  return concat_ws(' and ', format('uc.user_id = %L', coalesce(p_owned_by, p_uid)),
    case when v_q is not null then format('strpos(wm_index.search_text(uc.snapshot_title, uc.snapshot_category), %L) > 0', v_q) end,
    case when p_rarity <> '{}' then format('uc.snapshot_rarity = any (%L)', p_rarity) end,
    -- Étiquettes du lecteur seulement, comme les items : celles d'un autre joueur sont privées (RLS) et ne filtrent rien.
    case when p_tag_id is not null then format('exists (select from public.user_card_tags ut join public.tags t on t.id = ut.tag_id
      and t.user_id = %L where ut.user_card_id = uc.id and ut.tag_id = %L)', p_uid, p_tag_id) end,
    case when p_untagged then format('not exists (select from public.user_card_tags ut join public.tags t on t.id = ut.tag_id
      and t.user_id = %L where ut.user_card_id = uc.id)', p_uid) end,
    case when p_wishlisted_by is not null
      then format('uc.card_id in (select w.card_id from public.wishlist_items w where w.user_id = %L)', p_wishlisted_by) end);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
