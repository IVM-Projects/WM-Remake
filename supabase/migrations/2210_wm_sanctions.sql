-- ADDITIVE : sanctions du staff (G2, G3, G4 du M6a) — pose et levée d'un avertissement, d'une restriction, d'une suspension ou d'un
-- bannissement, état GoTrue à appliquer par la route (Task 9), « Rouvrir le check » des succès, recherche et fiche d'un joueur. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Pose d'une sanction : suspension et bannissement réservés aux admins ; un modérateur ne sanctionne pas un membre du staff (G2).
-- p_report_id qui vise bien ce joueur : son signalement passe à resolved, rattaché à la ligne d'audit ; sinon ignoré.
create or replace function wm.admin_sanction(p_uid uuid, p_user_id uuid, p_kind text, p_ends_at timestamptz, p_reason text,
  p_report_id uuid default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_role text;
  v_reason text;
  s wm.sanctions;
  v_action bigint;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  if p_kind is null or p_kind not in ('warning', 'restriction', 'suspension', 'ban') then
    perform wm.raise_err(400, 'invalid_request', 'Sanction inconnue');
  end if;
  v_role := wm.staff_actor(p_uid, case when p_kind in ('suspension', 'ban') then 'admin' else 'moderator' end);
  v_reason := wm.admin_reason(p_reason);
  if p_user_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas te sanctionner toi-même');
  end if;
  if not exists (select from public.profiles where id = p_user_id)
    or exists (select from wm.deleted_accounts where user_id = p_user_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  if v_role <> 'admin' and exists (select from wm.staff where user_id = p_user_id) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Action réservée aux administrateurs');
  end if;
  if p_kind in ('warning', 'ban') and p_ends_at is not null then
    perform wm.raise_err(400, 'invalid_request', 'Pas de date de fin pour ce type de sanction');
  end if;
  if p_kind in ('restriction', 'suspension')
    and (p_ends_at is null or p_ends_at <= now() or p_ends_at > now() + interval '365 days') then
    perform wm.raise_err(400, 'invalid_request', 'La date de fin doit être dans le futur, à un an au plus');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_user_id);
  insert into wm.sanctions (user_id, kind, reason, ends_at, created_by)
  values (p_user_id, p_kind, v_reason, p_ends_at, p_uid)
  returning * into s;
  v_action := wm.staff_log(p_uid, 'sanction', 'user', p_user_id::text, v_reason,
    jsonb_build_object('sanction_id', s.id, 'kind', s.kind, 'ends_at', s.ends_at, 'report_id', p_report_id));
  if exists (select from public.reports where id = p_report_id and reported_user_id = p_user_id) then
    insert into wm.report_reviews (report_id, status, reviewed_by, reviewed_at, staff_action_id)
    values (p_report_id, 'resolved', p_uid, now(), v_action)
    on conflict (report_id) do update set status = excluded.status, reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at, staff_action_id = excluded.staff_action_id;
  end if;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('sanction', wm.sanction_json(s), 'auth', wm.auth_state(p_user_id)));
end $$;

-- Levée : la sanction d'abord (for update), puis le profil visé. Personne ne lève une sanction qui le vise ; un modérateur ne lève ni
-- suspension, ni bannissement, ni sanction d'un membre du staff (G2).
create or replace function wm.admin_sanction_revoke(p_uid uuid, p_sanction_id bigint, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_role text;
  v_reason text;
  s wm.sanctions;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  v_role := wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  perform set_config('lock_timeout', '2s', true);
  select * into s from wm.sanctions where id = p_sanction_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Sanction introuvable');
  end if;
  if (s.kind in ('suspension', 'ban') and v_role <> 'admin') or s.user_id = p_uid
    or (v_role <> 'admin' and exists (select from wm.staff where user_id = s.user_id)) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Action réservée aux administrateurs');
  end if;
  if s.revoked_at is not null then
    perform wm.raise_err(409, null, 'Cette sanction est déjà levée');
  end if;
  perform wm.lock_user(s.user_id);
  update wm.sanctions set revoked_at = now() where id = s.id returning * into s;
  perform wm.staff_log(p_uid, 'sanction_revoke', 'sanction', s.id::text, v_reason,
    jsonb_build_object('user_id', s.user_id, 'kind', s.kind));
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('sanction', wm.sanction_json(s), 'auth', wm.auth_state(s.user_id)));
end $$;

-- « Resynchroniser la session » (G12) : rend l'état GoTrue attendu, que la route applique ; aucune écriture hors audit, d'où aucun verrou.
-- Un compte supprimé reste visé (suppression douce GoTrue à rattraper).
create or replace function wm.admin_auth_sync(p_uid uuid, p_user_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  v_auth jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid, 'admin');
  v_reason := wm.admin_reason(p_reason);
  if not exists (select from public.profiles where id = p_user_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  v_auth := wm.auth_state(p_user_id);
  perform wm.staff_log(p_uid, 'auth_sync', 'user', p_user_id::text, v_reason, jsonb_build_object('auth', v_auth));
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('auth', v_auth));
end $$;

-- « Rouvrir le check » (M6a-8, H:230) : le prochain achievements_check du joueur repasse toutes les règles.
create or replace function wm.admin_achievements_recheck(p_uid uuid, p_user_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  if not exists (select from public.profiles where id = p_user_id)
    or exists (select from wm.deleted_accounts where user_id = p_user_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_user_id);
  update wm.user_state set achievements_checked_at = null where user_id = p_user_id;
  perform wm.staff_log(p_uid, 'achievements_recheck', 'user', p_user_id::text, v_reason);
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Recherche par début de pseudo, insensible à la casse ; % et _ tapés sont littéraux ; comptes supprimés compris (marqués).
create or replace function wm.staff_user_search(p_uid uuid, p_q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := btrim(p_q);
begin
  perform wm.staff_actor(p_uid);
  if coalesce(char_length(v_q), 0) < 2 then
    perform wm.raise_err(400, 'invalid_request', 'Tape au moins 2 caractères');
  end if;
  v_q := replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_');
  return jsonb_build_object('users', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username,
      'created_at', u.created_at, 'deleted', u.deleted) order by lower(u.username))
    from (select p.id, p.username, p.created_at, exists (select from wm.deleted_accounts d where d.user_id = p.id) deleted
      from public.profiles p where lower(p.username) like v_q || '%'
      order by lower(p.username) limit (select (value ->> 'search')::int from wm.config where key = 'admin')) u), '[]'));
end $$;

-- Fiche d'un joueur pour le staff, sans e-mail ; un compte supprimé reste lisible (deleted_at, auth_pending tant que GoTrue n'a pas suivi).
create or replace function wm.staff_user_detail(p_uid uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.profiles;
  d wm.deleted_accounts;
begin
  perform wm.staff_actor(p_uid);
  select * into p from public.profiles where id = p_user_id;
  if not found then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  select * into d from wm.deleted_accounts where user_id = p_user_id;
  return jsonb_build_object(
    'user', jsonb_build_object('id', p.id, 'username', p.username, 'created_at', p.created_at, 'last_seen_at', p.last_seen_at,
      'is_pro', p.is_pro, 'is_vip', p.is_vip, 'balance', p.wikibidous_balance, 'is_public', p.is_public,
      'deleted_at', d.deleted_at, 'auth_pending', d.user_id is not null and d.auth_done_at is null),
    'staff_role', (select role from wm.staff where user_id = p_user_id),
    'sanctions', coalesce((select jsonb_agg(wm.sanction_json(s) order by s.created_at desc, s.id desc)
      from wm.sanctions s where s.user_id = p_user_id), '[]'),
    'reports_received', (select count(*) from public.reports where reported_user_id = p_user_id),
    'reports_filed', (select count(*) from public.reports where reporter_id = p_user_id),
    'guild', (select jsonb_build_object('id', g.id, 'name', g.name)
      from public.guild_members m join public.guilds g on g.id = m.guild_id where m.user_id = p_user_id));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
