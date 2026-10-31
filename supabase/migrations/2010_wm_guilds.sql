-- ADDITIVE : guildes (D§7.8, R§3.10, M5b-1, M5b-8, M5b-9, D-C10) — lecture avec invitations reçues, création gratuite (D:583), invitation
-- entre amis, adhésion sous les profils puis la guilde, refus d'une invitation. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- GET /api/guilds : la guilde du joueur, son appartenance, le nombre de membres et ses invitations reçues (M5b-8, la plus récente
-- d'abord, départage par guild_id). Sans guilde : guild et membership nuls, 0 membre.
create or replace function wm.guild_get(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'guild', (select jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'leader_id', g.leader_id,
        'created_at', g.created_at)
      from public.guild_members m join public.guilds g on g.id = m.guild_id where m.user_id = p_uid),
    'membership', (select jsonb_build_object('guild_id', m.guild_id, 'user_id', m.user_id, 'role', m.role, 'joined_at', m.joined_at)
      from public.guild_members m where m.user_id = p_uid),
    'member_count', (select count(*) from public.guild_members o join public.guild_members m on m.guild_id = o.guild_id
      where m.user_id = p_uid),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('guild_id', i.guild_id, 'guild_name', g.name,
        'inviter_username', p.username, 'created_at', i.created_at) order by i.created_at desc, i.guild_id)
      from wm.guild_invites i join public.guilds g on g.id = i.guild_id join public.profiles p on p.id = i.inviter_id
      where i.user_id = p_uid), '[]'))
$$;

-- Création gratuite (D:583) : le créateur devient chef ; ses invitations reçues sont effacées (M5b-8).
create or replace function wm.guild_create(p_uid uuid, p_name text, p_description text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_name text := regexp_replace(p_name, '^\s+|\s+$', '', 'g');
  g uuid;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if coalesce(v_name, '') = '' then
    perform wm.raise_err(400, 'invalid_request', 'Le nom de la guilde est vide');
  end if;
  if char_length(v_name) > 40 then
    perform wm.raise_err(400, 'invalid_request', 'Un nom de guilde fait au plus 40 caractères');
  end if;
  if char_length(p_description) > 280 then
    perform wm.raise_err(400, 'invalid_request', 'Une description fait au plus 280 caractères');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  if exists (select from public.guild_members where user_id = p_uid) then
    perform wm.raise_err(409, null, 'Tu fais déjà partie d''une guilde');
  end if;
  insert into public.guilds (name, description, leader_id)
  values (v_name, case when p_description ~ '^\s*$' then null else p_description end, p_uid)
  returning id into g;
  insert into public.guild_members (guild_id, user_id, role) values (g, p_uid, 'leader');
  delete from wm.guild_invites where user_id = p_uid;
  return wm.idem_store(p_uid, p_idem, wm.guild_get(p_uid));
end $$;

-- Invitation d'un ami (M5b-8) : réécrit une invitation existante (inviteur, instant) et notifie à chaque fois (M5b-11).
-- Instant clock_timestamp() à l'insertion comme à la réécriture : deux invitations d'une même transaction restent ordonnées (C1).
create or replace function wm.guild_invite(p_uid uuid, p_user_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  g uuid;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_user_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas t''inviter toi-même');
  end if;
  if not exists (select from public.profiles where id = p_user_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_users(array[p_uid, p_user_id]);
  select guild_id into g from public.guild_members where user_id = p_uid;
  perform from public.guilds where id = g for no key update;
  -- Appartenance relue sous le verrou de la guilde : guild_leave ne prend aucun profil, un départ a pu valider entre-temps.
  if not found or not exists (select from public.guild_members where user_id = p_uid and guild_id = g) then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  if not wm.are_friends(p_uid, p_user_id) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour inviter ce joueur');
  end if;
  if exists (select from public.guild_members where user_id = p_user_id) then
    perform wm.raise_err(409, null, 'Ce joueur fait déjà partie d''une guilde');
  end if;
  insert into wm.guild_invites (guild_id, user_id, inviter_id, created_at) values (g, p_user_id, p_uid, clock_timestamp())
  on conflict (guild_id, user_id) do update set inviter_id = excluded.inviter_id, created_at = clock_timestamp();
  perform wm.notify_guild(array[p_user_id], 'guild_invite', g, p_uid);
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Adhésion sur invitation : le profil, puis la guilde (M5b-1), qui sérialise les adhésions au plafond ; efface toutes les invitations
-- du joueur (M5b-8).
create or replace function wm.guild_join(p_uid uuid, p_guild_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  perform from public.guilds where id = p_guild_id for no key update;
  if not found then
    perform wm.raise_err(404, null, 'Guilde introuvable');
  end if;
  if exists (select from public.guild_members where user_id = p_uid) then
    perform wm.raise_err(409, null, 'Tu fais déjà partie d''une guilde');
  end if;
  if not exists (select from wm.guild_invites where guild_id = p_guild_id and user_id = p_uid) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Aucune invitation de cette guilde');
  end if;
  if (select count(*) from public.guild_members where guild_id = p_guild_id)
      >= (select (value ->> 'max_members')::int from wm.config where key = 'guild') then
    perform wm.raise_err(409, null, 'Cette guilde est pleine');
  end if;
  insert into public.guild_members (guild_id, user_id, role) values (p_guild_id, p_uid, 'member');
  delete from wm.guild_invites where user_id = p_uid;
  return wm.idem_store(p_uid, p_idem, wm.guild_get(p_uid));
end $$;

-- Refus d'une invitation reçue : la seule ligne d'invitation, aucun profil.
create or replace function wm.guild_invite_decline(p_uid uuid, p_guild_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  delete from wm.guild_invites where guild_id = p_guild_id and user_id = p_uid;
  if not found then
    perform wm.raise_err(404, null, 'Aucune invitation de cette guilde');
  end if;
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Départ : le souhait ouvert d'abord (G3), puis la guilde (aucun profil, M5b-1). Le chef ne part que s'il est seul : la guilde est alors
-- dissoute (D-C20, cascade). Les messages restent (M5b-10).
create or replace function wm.guild_leave(p_uid uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  g uuid;
  v_role public.guild_role;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  perform from public.guild_wishlists where user_id = p_uid and fulfilled_at is null for update;
  select guild_id into g from public.guild_members where user_id = p_uid;
  if g is not null then
    perform from public.guilds where id = g for no key update;
    select role into v_role from public.guild_members where user_id = p_uid and guild_id = g;
  end if;
  if v_role is null then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  if v_role = 'leader' then
    if exists (select from public.guild_members where guild_id = g and user_id <> p_uid) then
      perform wm.raise_err(409, null, 'Transmets d''abord ton rôle de chef à un autre membre');
    end if;
    perform from public.guilds where id = g for update;
    delete from public.guilds where id = g;
  else
    delete from public.guild_members where user_id = p_uid and guild_id = g;
    delete from public.guild_wishlists where user_id = p_uid and fulfilled_at is null;
  end if;
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Exclusion par le chef : souhait ouvert de la cible (G3), son profil (G2), puis la guilde ; la cible est notifiée (M5b-11).
create or replace function wm.guild_kick(p_uid uuid, p_user_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  g uuid;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_user_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas t''exclure toi-même');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform from public.guild_wishlists where user_id = p_user_id and fulfilled_at is null for update;
  perform from public.profiles where id = p_user_id for key share;
  select guild_id into g from public.guild_members where user_id = p_uid;
  perform from public.guilds where id = g for no key update;
  if not found or not exists (select from public.guild_members where user_id = p_uid and guild_id = g) then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  if not exists (select from public.guild_members where user_id = p_uid and guild_id = g and role = 'leader') then
    perform wm.raise_err(403, 'FORBIDDEN', 'Seul le chef de la guilde peut faire cela');
  end if;
  if not exists (select from public.guild_members where user_id = p_user_id and guild_id = g) then
    perform wm.raise_err(404, null, 'Ce joueur ne fait pas partie de ta guilde');
  end if;
  delete from public.guild_members where user_id = p_user_id and guild_id = g;
  delete from public.guild_wishlists where user_id = p_user_id and fulfilled_at is null;
  perform wm.notify_guild(array[p_user_id], 'guild_kicked', g, p_uid);
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Transfert du rôle de chef (M5b-10) : le chef d'abord (403, C17), puis soi-même (400), puis la cible. L'ancien chef passe member avant la
-- cible (index unique guild_members_leader_key). Aucune notification (M5b-11).
create or replace function wm.guild_transfer(p_uid uuid, p_user_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  g uuid;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_users(array[p_uid, p_user_id]);
  select guild_id into g from public.guild_members where user_id = p_uid;
  perform from public.guilds where id = g for no key update;
  if not found or not exists (select from public.guild_members where user_id = p_uid and guild_id = g) then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  if not exists (select from public.guild_members where user_id = p_uid and guild_id = g and role = 'leader') then
    perform wm.raise_err(403, 'FORBIDDEN', 'Seul le chef de la guilde peut faire cela');
  end if;
  if p_user_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu es déjà le chef de la guilde');
  end if;
  if not exists (select from public.guild_members where user_id = p_user_id and guild_id = g) then
    perform wm.raise_err(404, null, 'Ce joueur ne fait pas partie de ta guilde');
  end if;
  update public.guild_members set role = 'member' where user_id = p_uid and guild_id = g;
  update public.guild_members set role = 'leader' where user_id = p_user_id and guild_id = g;
  update public.guilds set leader_id = p_user_id where id = g;
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Membres, chef d'abord (union des variantes de R:292 : id, username, profile, user), page bornée par list_caps.guild_members.
create or replace function wm.guild_members(p_uid uuid, p_limit int default null, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g uuid;
  v_cap int := (select (value ->> 'guild_members')::int from wm.config where key = 'list_caps');
  v_lim int;
  v_off int := greatest(0, coalesce(p_offset, 0));
  v_members jsonb;
  v_more boolean;
begin
  select guild_id into g from public.guild_members where user_id = p_uid;
  if g is null then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  v_lim := greatest(1, least(coalesce(p_limit, v_cap), v_cap));
  select coalesce(jsonb_agg(jsonb_build_object('user_id', r.user_id, 'id', r.user_id, 'username', r.username,
      'profile', jsonb_build_object('username', r.username), 'user', jsonb_build_object('username', r.username),
      'role', r.role, 'joined_at', r.joined_at) order by r.n) filter (where r.n <= v_lim), '[]'),
    coalesce(max(r.n), 0) > v_lim
  into v_members, v_more
  from (select s.*, row_number() over (order by (s.role = 'leader') desc, s.joined_at, s.user_id) n
    from (select m.user_id, m.role, m.joined_at, p.username from public.guild_members m join public.profiles p on p.id = m.user_id
      where m.guild_id = g order by (m.role = 'leader') desc, m.joined_at, m.user_id limit v_lim + 1 offset v_off) s) r;
  return jsonb_build_object('members', v_members, 'hasMore', v_more);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
