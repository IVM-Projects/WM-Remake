-- ADDITIVE : entraide de guilde (D§7.8, R§3.10, M5b-4, M5b-7, M5b-11, G3, G6, G18, D-C13, D-C19) — move_copies extrait de trade_move
-- (redéfinie : même signature et même réponse qu'en 1800, ses six instructions passent telles quelles dans move_copies), souhait unique
-- remplacé, retrait, don d'une unité (un don reçu par jour UTC du receveur), entraide avec karma de la semaine. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Seul update … set user_id permis hors défausse et enchères (M4-3) ; copies déjà verrouillées et vérifiées par l'appelant, aucun
-- lock_timeout ici. Chaque copie de p_ids passe de son propriétaire (p_a ou p_b) à l'autre, p_k[i] unités : k = n déplace la ligne (même id,
-- même count), k < n crée une ligne de count k chez l'autre joueur et décrémente la source, sans fusion. Ce qui arrive est sans étoile ni
-- étiquette ; l'avatar et l'emplacement de vitrine d'une copie déplacée en entier sont effacés, une pile donnée en partie garde les siens
-- (M4b-7).
create or replace function wm.move_copies(p_a uuid, p_b uuid, p_ids uuid[], p_k int[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_full uuid[];
  v_part uuid[];
  v_k int[];
begin
  select array_agg(x.id order by x.id) filter (where x.k = uc.count), array_agg(x.id order by x.id) filter (where x.k < uc.count),
    array_agg(x.k order by x.id) filter (where x.k < uc.count)
  into v_full, v_part, v_k
  from unnest(p_ids, p_k) x (id, k) join public.user_cards uc on uc.id = x.id;
  update public.user_cards set user_id = case user_id when p_a then p_b else p_a end, starred = false where id = any (v_full);
  insert into public.user_cards (user_id, card_id, count, starred, is_shiny, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk,
    snapshot_def, obtained_at)
  select case uc.user_id when p_a then p_b else p_a end, uc.card_id, x.k, false, uc.is_shiny,
    uc.snapshot_title, uc.snapshot_rarity, uc.snapshot_category, uc.snapshot_atk, uc.snapshot_def, uc.obtained_at
  from unnest(v_part, v_k) x (id, k) join public.user_cards uc on uc.id = x.id;
  update public.user_cards set count = count - x.k from unnest(v_part, v_k) x (id, k) where user_cards.id = x.id;
  -- shortcut: un lien posé par l'ancien propriétaire pendant l'acceptation (insert concurrent qui attend la clé étrangère) survit sur la copie
  -- déplacée, invisible par RLS ; pour l'exclure, trigger after insert sur user_card_tags qui relit la copie for key share.
  delete from public.user_card_tags where user_card_id = any (v_full);
  update public.profiles set avatar_user_card_id = null
  where avatar_user_card_id = any (v_full) and id in (p_a, p_b);
  delete from public.showcase where user_card_id = any (v_full);
end $$;

-- Redéfinie de 1800 (D-C19) : même signature et même réponse ; les copies et leurs k se lisent dans trade_items comme en 1800, puis
-- move_copies fait les six instructions de 1800, inchangées.
create or replace function wm.trade_move(p_trade public.trades)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_k int[];
begin
  select array_agg(user_card_id order by user_card_id), array_agg(k order by user_card_id)
  into v_ids, v_k
  from (select user_card_id, count(*)::int k from public.trade_items where trade_id = p_trade.id group by user_card_id) x;
  perform wm.move_copies(p_trade.initiator_id, p_trade.recipient_id, v_ids, v_k);
end $$;

-- Souhait (M5b-4) : un ouvert au plus, remplacé. Le souhait ouvert d'abord (G3), puis le profil, puis la guilde en for key share (M5b-1) ;
-- l'adhésion est relue sous la guilde (un départ ne prend aucun profil).
create or replace function wm.guild_wish_set(p_uid uuid, p_card_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  g uuid;
  w public.guild_wishlists;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if not exists (select from public.cards where id = p_card_id) then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform from public.guild_wishlists where user_id = p_uid and fulfilled_at is null for update;
  perform wm.lock_user(p_uid);
  select guild_id into g from public.guild_members where user_id = p_uid;
  perform from public.guilds where id = g for key share;
  if not found or not exists (select from public.guild_members where user_id = p_uid and guild_id = g) then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  delete from public.guild_wishlists where user_id = p_uid and fulfilled_at is null;
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, p_uid, p_card_id) returning * into w;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('wishlist', jsonb_build_object('id', w.id, 'user_id', w.user_id,
    'card_id', w.card_id, 'created_at', w.created_at)));
end $$;

-- Retrait du souhait ouvert : la seule ligne du souhait, aucun profil (G3). Sans guilde : 404 (M5b-9, C6).
create or replace function wm.guild_wish_clear(p_uid uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if not exists (select from public.guild_members where user_id = p_uid) then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  perform set_config('lock_timeout', '2s', true);
  delete from public.guild_wishlists where user_id = p_uid and fulfilled_at is null;
  if not found then
    perform wm.raise_err(404, null, 'Tu ne demandes aucune carte');
  end if;
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Don d'une unité (M5b-4, D:574) : le souhait (G3), les deux profils, la guilde en for key share, puis la copie du donneur. Le souhait d'un
-- auteur qui n'est plus membre n'existe plus (G18), lu avant la guilde : une dissolution qui attend ce souhait ne croise jamais ce verrou.
-- Un don reçu par jour UTC du receveur (D-C13), compté sous son profil.
create or replace function wm.guild_donate(p_uid uuid, p_wishlist_id uuid, p_user_card_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  w public.guild_wishlists;
  g uuid;
  k public.user_cards;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  select * into w from public.guild_wishlists where id = p_wishlist_id and fulfilled_at is null for update;
  if not found then
    perform wm.raise_err(404, null, 'Ce souhait n''existe plus');
  end if;
  if w.user_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas te donner une carte');
  end if;
  perform wm.lock_users(array[p_uid, w.user_id]);
  if not exists (select from public.guild_members m where m.user_id = w.user_id and m.guild_id = w.guild_id) then
    perform wm.raise_err(404, null, 'Ce souhait n''existe plus');
  end if;
  perform from public.guilds where id = w.guild_id for key share;
  -- Adhésion du donneur relue sous la guilde : un départ ne prend aucun profil.
  select guild_id into g from public.guild_members where user_id = p_uid;
  if g is null then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  if g <> w.guild_id then
    perform wm.raise_err(403, 'FORBIDDEN', 'Ce souhait n''est pas dans ta guilde');
  end if;
  if (select count(*) from public.guild_donations
      where recipient_id = w.user_id and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
      >= (select (value ->> 'donations_per_day')::int from wm.config where key = 'guild') then
    perform wm.raise_err(409, null, 'Ce membre a déjà reçu un don aujourd''hui');
  end if;
  select * into k from public.user_cards where id = p_user_card_id and user_id = p_uid for update;
  if not found then
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  if k.card_id <> w.card_id then
    perform wm.raise_err(400, 'invalid_request', 'Cette carte n''est pas celle demandée');
  end if;
  if wm.card_locked(p_uid, k.card_id) then
    perform wm.raise_err(409, null, 'Cette carte est déjà engagée dans un échange en attente');
  end if;
  perform wm.move_copies(p_uid, w.user_id, array[k.id], array[1]);
  update public.guild_wishlists set fulfilled_at = now() where id = w.id;
  insert into public.guild_donations (guild_id, wishlist_id, donor_id, recipient_id, user_card_id)
  values (w.guild_id, w.id, p_uid, w.user_id, k.id);
  perform wm.notify_guild(array[w.user_id], 'guild_donation', w.guild_id, p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'wishlist_id', w.id));
end $$;

-- GET /api/guilds/home : souhaits ouverts des membres de la guilde du lecteur (G18), le sien à part ; copies du lecteur de la carte
-- souhaitée (G6) ; dix meilleurs donneurs de la semaine (M5b-7) ; don du jour reçu (UTC, D-C13).
create or replace function wm.guild_home(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g uuid;
  v_day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_per_day int := (select (value ->> 'donations_per_day')::int from wm.config where key = 'guild');
  v_cap int := (select (value ->> 'karma_donors')::int from wm.config where key = 'list_caps');
  v_mine jsonb;
  v_others jsonb;
  v_donors jsonb;
begin
  select guild_id into g from public.guild_members where user_id = p_uid;
  if g is null then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  select (array_agg(s.v) filter (where s.user_id = p_uid))[1],
    coalesce(jsonb_agg(s.v order by s.created_at, s.id) filter (where s.user_id <> p_uid), '[]')
  into v_mine, v_others
  from (select w.id, w.user_id, w.created_at, jsonb_build_object('id', w.id, 'user_id', w.user_id,
      'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title, 'rarity', c.rarity, 'category', c.category, 'atk', c.atk,
        'def', c.def, 'image_url', c.image_url, 'hide_image', c.hide_image, 'nsfw_image', c.nsfw_image, 'wikipedia_url', c.wikipedia_url,
        'description', c.category, 'summary', c.summary),
      'created_at', w.created_at,
      'can_donate', w.user_id <> p_uid and jsonb_array_length(mc.v) > 0 and not rt.v,
      'recipient_received_today', rt.v,
      'user', jsonb_build_object('id', p.id, 'username', p.username), 'recipient', jsonb_build_object('id', p.id, 'username', p.username),
      'my_copies', mc.v) v
    from public.guild_wishlists w
    join public.guild_members m on m.user_id = w.user_id and m.guild_id = w.guild_id
    join public.profiles p on p.id = w.user_id
    join public.cards c on c.id = w.card_id
    cross join lateral (select (select count(*) from public.guild_donations d where d.recipient_id = w.user_id and d.created_at >= v_day)
      >= v_per_day v) rt
    cross join lateral (select case when wm.card_locked(p_uid, w.card_id) then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
        'id', uc.id, 'count', uc.count, 'is_shiny', uc.is_shiny) order by uc.id) from public.user_cards uc
        where uc.user_id = p_uid and uc.card_id = w.card_id), '[]') end v) mc
    where w.guild_id = g and w.fulfilled_at is null) s;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', t.donor_id, 'username', t.username, 'karma', t.karma, 'karma_this_week', t.n,
      'donations_this_week', t.n) order by t.n desc, t.username), '[]')
  into v_donors
  from (select d.donor_id, p.username, count(*)::int n,
      (select count(*)::int from public.guild_donations a where a.donor_id = d.donor_id) karma
    from public.guild_donations d
    join public.guild_members m on m.user_id = d.donor_id and m.guild_id = g
    join public.profiles p on p.id = d.donor_id
    where d.guild_id = g and d.created_at >= wm.week_start(now())
    group by d.donor_id, p.username
    order by n desc, p.username
    limit v_cap) t;
  return jsonb_build_object('my_wishlist', v_mine, 'wishlists', v_others, 'weekly_karma_donors', v_donors,
    'received_donation_today', (select count(*) from public.guild_donations where recipient_id = p_uid and created_at >= v_day) >= v_per_day);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
