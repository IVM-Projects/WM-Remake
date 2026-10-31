-- ADDITIVE : socle de la modération du M6a (D§7.12, G1 à G10 du M6a) — config image_reports, account_export et admin, user_state.export_at,
-- audit staff_actions, signalements d'image, revues de signalements, comptes supprimés, empreintes d'e-mail bannies, index ; actor (même
-- signature, même corps et même réponse qu'en 1000 (déployée, non retouchée), plus le refus d'un compte supprimé), email_hash, staff_actor,
-- admin_reason, staff_log, auth_state, access_check, staff_me, sanction_json. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : aucun DELETE/UPDATE ici.

insert into wm.config (key, value, note) values
  ('image_reports', '{"hide_threshold": 10}', 'Signaleurs distincts avant le masquage automatique de l''image (D:638)'),
  ('account_export', '{"interval_s": 600}', 'Un export du compte par joueur et par fenêtre (G10)'),
  ('admin', '{"page": 50, "dm_messages": 100, "guild_messages": 100, "search": 20, "removals": 100}',
    'Tailles des listes de l''espace staff (G9)')
on conflict do nothing;

-- Dernier export du compte (G10).
alter table wm.user_state add column if not exists export_at timestamptz;

-- Audit des actions du staff (G8) : insertion seule ; staff_id nul = système, sans clé étrangère (l'audit survit au staff).
create table if not exists wm.staff_actions (
  id bigint generated always as identity primary key,
  staff_id uuid,
  action text not null,
  target_type text not null check (target_type in ('user', 'card', 'guild', 'guild_message', 'guild_wish', 'dm', 'dm_pair', 'report',
    'sanction')),
  target_id text not null,
  reason text not null check (char_length(reason) between 3 and 500),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Un signalement d'image par joueur et par carte (G5).
create table if not exists wm.card_image_reports (
  card_id uuid not null references public.cards (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (card_id, user_id)
);

-- Revue d'un signalement de joueur (public.reports est un miroir : son état vit ici).
create table if not exists wm.report_reviews (
  report_id uuid primary key references public.reports (id) on delete cascade,
  status text not null check (status in ('resolved', 'dismissed')),
  reviewed_by uuid not null,
  reviewed_at timestamptz not null default now(),
  staff_action_id bigint not null
);

-- Pierres tombales (G1) ; auth_done_at nul tant que GoTrue n'a pas fait la suppression douce (G12).
create table if not exists wm.deleted_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  deleted_at timestamptz not null default now(),
  auth_done_at timestamptz
);

-- Empreintes d'e-mail d'un compte supprimé sous bannissement (G1, anti-évasion), sans clé étrangère.
create table if not exists wm.banned_emails (
  email_hash text primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

-- Option A : CONCURRENTLY par le runbook. sanctions_user_idx : wm.actor parcourait la table (V:34).
create index if not exists sanctions_user_idx on wm.sanctions (user_id, created_at desc);
create index if not exists staff_actions_created_idx on wm.staff_actions (created_at desc, id desc);
create index if not exists staff_actions_target_idx on wm.staff_actions (target_type, target_id, created_at desc);
create index if not exists staff_actions_staff_idx on wm.staff_actions (staff_id, created_at desc);
create index if not exists card_image_reports_user_idx on wm.card_image_reports (user_id);
create index if not exists reports_created_idx on public.reports (created_at desc);
create index if not exists trade_items_card_idx on public.trade_items (card_id);
create index if not exists auctions_active_card_idx on public.auctions (card_id) where status = 'active';
create index if not exists deleted_accounts_auth_pending_idx on wm.deleted_accounts (deleted_at) where auth_done_at is null;

-- Premier appel de chaque fonction qui écrit. Sans verrou : les verrous viennent ensuite, dans l'ordre C4.
create or replace function wm.actor(p_uid uuid, p_scope text default 'any')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  v_role text;
  v_ends timestamptz;
begin
  if (select value from wm.config where key = 'maintenance') = 'true'::jsonb then
    perform wm.raise_err(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.');
  end if;
  select * into p from public.profiles where id = p_uid;
  if not found then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  -- Compte supprimé (G1) : la pierre tombale garde sa ligne profiles, la session est close pour toute écriture.
  if exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  -- Sanction sans fin d'abord : la date renvoyée est alors null (durée indéterminée).
  select s.ends_at into v_ends from wm.sanctions s
  where s.user_id = p_uid and s.kind in ('restriction', 'suspension', 'ban') and s.revoked_at is null
    and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())
  order by s.ends_at desc nulls first limit 1;
  if found or p.activity_blocked_until > now() then
    perform wm.raise_err(403, null, 'Ton compte est temporairement restreint.', jsonb_build_object('activity_blocked_until',
      case when found and v_ends is null then null else greatest(v_ends, p.activity_blocked_until) end));
  end if;
  if p_scope = 'packs' and p.packs_blocked_until > now() then
    perform wm.raise_err(403, null, 'Ton compte est temporairement restreint.',
      jsonb_build_object('packs_blocked_until', p.packs_blocked_until));
  end if;
  select role into v_role from wm.staff where user_id = p_uid;
  return jsonb_build_object('is_pro', p.is_pro, 'is_vip', p.is_vip, 'is_staff', v_role is not null, 'staff_role', v_role);
end $$;

-- Empreinte d'e-mail (G1) : SHA-256 hexadécimal, minuscules, sans espaces autour, sans sel ; nul pour un e-mail nul.
create or replace function wm.email_hash(p_email text)
returns text language sql immutable security definer set search_path = '' as $$
  select encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex')
$$;

-- Premier appel de chaque fonction staff (G2, G4) : rend le rôle. Ignore maintenance ; refuse un membre du staff sous restriction,
-- suspension ou bannissement actifs (requête de wm.actor ; activity_blocked_until ne compte pas, G3). Ne verrouille rien.
create or replace function wm.staff_actor(p_uid uuid, p_min_role text default 'moderator')
returns text language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  v_role text;
  v_ends timestamptz;
begin
  select * into p from public.profiles where id = p_uid;
  if not found or exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  select role into v_role from wm.staff where user_id = p_uid;
  if v_role is null then
    perform wm.raise_err(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération');
  end if;
  if p_min_role = 'admin' and v_role <> 'admin' then
    perform wm.raise_err(403, 'FORBIDDEN', 'Action réservée aux administrateurs');
  end if;
  select s.ends_at into v_ends from wm.sanctions s
  where s.user_id = p_uid and s.kind in ('restriction', 'suspension', 'ban') and s.revoked_at is null
    and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())
  order by s.ends_at desc nulls first limit 1;
  if found then
    perform wm.raise_err(403, null, 'Ton compte est temporairement restreint.', jsonb_build_object('activity_blocked_until', v_ends));
  end if;
  return v_role;
end $$;

-- Motif obligatoire de toute wm.admin_* : rogné, 3 à 500 caractères.
create or replace function wm.admin_reason(p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v text := regexp_replace(p_reason, '^\s+|\s+$', '', 'g');
begin
  if v is null or char_length(v) not between 3 and 500 then
    perform wm.raise_err(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)');
  end if;
  return v;
end $$;

-- Une ligne d'audit (G8), sous les verrous de l'appelant ; rend son id.
create or replace function wm.staff_log(p_staff uuid, p_action text, p_target_type text, p_target_id text, p_reason text,
  p_payload jsonb default '{}')
returns bigint language sql security definer set search_path = '' as $$
  insert into wm.staff_actions (staff_id, action, target_type, target_id, reason, payload)
  values (p_staff, p_action, p_target_type, p_target_id, p_reason, p_payload)
  returning id
$$;

-- État GoTrue attendu d'un compte (G4, G12) : une restriction ne compte pas (G3).
create or replace function wm.auth_state(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('user_id', p_user_id,
    'deleted', exists (select from wm.deleted_accounts where user_id = p_user_id),
    'forever', coalesce(f.forever, false),
    'ban_until', case when f.forever then null else f.until end)
  from (select bool_or(s.kind = 'ban' and s.ends_at is null) forever, max(s.ends_at) until from wm.sanctions s
    where s.user_id = p_user_id and s.kind in ('suspension', 'ban') and s.revoked_at is null
      and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())) f
$$;

-- Contrôle des lectures connectées (G4) : 401 compte absent ou supprimé, 403 suspension ou bannissement actifs ; une restriction lit.
create or replace function wm.access_check(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_ends timestamptz;
begin
  if not exists (select from public.profiles where id = p_uid) or exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  select s.ends_at into v_ends from wm.sanctions s
  where s.user_id = p_uid and s.kind in ('suspension', 'ban') and s.revoked_at is null
    and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())
  order by s.ends_at desc nulls first limit 1;
  if found then
    perform wm.raise_err(403, null, 'Ton compte est temporairement restreint.', jsonb_build_object('activity_blocked_until', v_ends));
  end if;
  return '{"ok": true}'::jsonb;
end $$;

-- Rôle du lecteur pour le lien « Administration » (G14) ; jamais d'erreur.
create or replace function wm.staff_me(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('role', (select s.role from wm.staff s where s.user_id = p_uid
    and not exists (select from wm.deleted_accounts d where d.user_id = p_uid)))
$$;

-- Une sanction lue par le staff : la ligne, son état actif et le pseudo de son auteur (nul pour le système).
create or replace function wm.sanction_json(s wm.sanctions)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) || jsonb_build_object(
    'active', s.revoked_at is null and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now()),
    'created_by_username', (select p.username from public.profiles p where p.id = s.created_by))
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
