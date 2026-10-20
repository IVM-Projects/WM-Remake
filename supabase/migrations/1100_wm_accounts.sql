-- ADDITIVE : comptes (D§7.0, D§7.1, C4, C28) — état joueur, trigger d'inscription, pseudos, préférences, vérification humaine, régénération des paquets (D§7.2). Idempotente.

insert into wm.config (key, value, note) values
  ('reserved_usernames', '["admin","administrateur","administrator","staff","moderateur","moderator","modo","support","wikimasters","wikicartes","system","systeme"]',
   'Pseudos refusés aux nouveaux noms, comparés en minuscules (C28)'),
  ('username_change_days', '30', 'Jours minimum entre deux changements de pseudo (D§7.1)'),
  ('human_check_ttl_h', '12', 'Validité de la vérification humaine, en heures (D§7.0, R§5.1)'),
  ('pack_period_s', '{"free":600,"pro":180}', 'Secondes par paquet régénéré ; is_pro ou is_vip → pro. free 600 conf., pro 180 prob. (R§5.1, D§7.2)')
on conflict do nothing;

create table if not exists wm.user_state (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  human_verified_until timestamptz,
  last_open_at timestamptz,
  opens_day date,
  opens_day_count int not null default 0,
  open_window_start timestamptz,
  open_window_count int not null default 0,
  username_changed_at timestamptz
);

create table if not exists wm.user_stats (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  packs_opened int not null default 0,
  cards_obtained int not null default 0,
  discarded int not null default 0,
  discard_wb int not null default 0
);

create table if not exists wm.user_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  sounds boolean not null default true,
  hide_sensitive boolean not null default true
);

-- Étapes 2 et 3 de C4 pour un joueur ; les lignes wm manquantes (profil migré, sans trigger) sont créées au passage.
create or replace function wm.lock_user(p_uid uuid)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = p_uid for update;
  if not found then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  insert into wm.user_state (user_id) values (p_uid) on conflict do nothing;
  insert into wm.user_stats (user_id) values (p_uid) on conflict do nothing;
  insert into wm.user_prefs (user_id) values (p_uid) on conflict do nothing;
  perform from wm.user_state where user_id = p_uid for update;
  return p;
end $$;

-- Règle des nouveaux pseudos (C28) ; les pseudos existants ne sont jamais revérifiés. p_uid : son propre pseudo n'est pas « pris ».
create or replace function wm.username_problem(p_username text, p_uid uuid default null)
returns text language sql security definer set search_path = '' as $$
  select case
    when p_username is null or p_username !~ '^[A-Za-z0-9_.-]{3,24}$' then 'invalid'
    when lower(p_username) in (select jsonb_array_elements_text(value) from wm.config where key = 'reserved_usernames') then 'reserved'
    when exists (select from public.profiles where lower(username) = lower(p_username) and id is distinct from p_uid) then 'taken'
  end
$$;

-- Seule source des erreurs de pseudo : l'inscription, le renommage et username_available passent par elle.
create or replace function wm.raise_username(p_problem text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  case p_problem
    when 'invalid' then perform wm.raise_err(400, 'username_invalid', 'Pseudo invalide (3 à 24 caractères)');
    when 'reserved' then perform wm.raise_err(400, 'username_reserved', 'Ce pseudo est réservé');
    when 'taken' then perform wm.raise_err(409, 'username_taken', 'Ce pseudo est déjà pris');
    else null;
  end case;
end $$;

create or replace function wm.username_available(p_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_problem text := wm.username_problem(p_username); d text;
begin
  perform wm.raise_username(v_problem);
  return '{"available": true}';
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return jsonb_build_object('available', false, 'reason', v_problem, 'error', d::jsonb ->> 'error');
end $$;

-- Inscription GoTrue (D§7.1) : un refus lève P0001, que GoTrue relaie en 500 avec message et detail.
create or replace function wm.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}');
begin
  if m -> 'age_confirmed' is distinct from 'true'::jsonb or coalesce(btrim(m ->> 'terms_version'), '') = '' then
    perform wm.raise_err(400, 'consent_required', 'Confirme avoir au moins 18 ans et accepte les conditions.');
  end if;
  perform wm.raise_username(wm.username_problem(m ->> 'username'));
  begin
    insert into public.profiles (id, username) values (new.id, m ->> 'username');
  exception when unique_violation then  -- inscription concurrente passée entre la vérification et l'insertion
    perform wm.raise_username('taken');
  end;
  perform wm.lock_user(new.id);  -- crée les lignes wm
  return null;
end $$;

create or replace trigger wm_on_auth_user_created after insert on auth.users
  for each row execute function wm.handle_new_user();

create or replace function wm.change_username(p_uid uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_days int := (select value::int from wm.config where key = 'username_change_days');
  v_next timestamptz;
  p public.profiles;
begin
  perform wm.actor(p_uid);
  p := wm.lock_user(p_uid);
  select username_changed_at + make_interval(days => v_days) into v_next from wm.user_state where user_id = p_uid;
  if p.username = p_username then  -- même pseudo exact : rien à changer, le délai n'est pas consommé
    return jsonb_build_object('username', p_username, 'next_change_at', v_next);
  end if;
  if v_next > now() then
    perform wm.raise_err(409, 'username_change_too_soon', format('Un seul changement de pseudo tous les %s jours.', v_days),
      jsonb_build_object('next_change_at', v_next));
  end if;
  perform wm.raise_username(wm.username_problem(p_username, p_uid));
  begin
    update public.profiles set username = p_username where id = p_uid;
  exception when unique_violation then  -- même course que l'inscription
    perform wm.raise_username('taken');
  end;
  update wm.user_state set username_changed_at = now() where user_id = p_uid;
  return jsonb_build_object('username', p_username, 'next_change_at', now() + make_interval(days => v_days));
end $$;

-- Lecture sans verrou : un profil migré sans ligne user_prefs lit les défauts de la table.
create or replace function wm.get_prefs(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  select jsonb_build_object('sounds', coalesce(u.sounds, true), 'hide_sensitive', coalesce(u.hide_sensitive, true), 'is_public', p.is_public)
  into r from public.profiles p left join wm.user_prefs u on u.user_id = p.id where p.id = p_uid;
  if not found then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  return r;
end $$;

create or replace function wm.set_prefs(p_uid uuid, p_sounds boolean, p_hide_sensitive boolean, p_is_public boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform wm.actor(p_uid);
  perform wm.lock_user(p_uid);
  update wm.user_prefs set sounds = coalesce(p_sounds, sounds), hide_sensitive = coalesce(p_hide_sensitive, hide_sensitive)
  where user_id = p_uid;
  update public.profiles set is_public = coalesce(p_is_public, is_public) where id = p_uid;
  return wm.get_prefs(p_uid);
end $$;

-- Turnstile validé par le serveur (D§7.1) : la rafale d'ouvertures repart de zéro.
create or replace function wm.set_human_verified(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform wm.actor(p_uid);
  perform wm.lock_user(p_uid);
  update wm.user_state
  set human_verified_until = now() + make_interval(hours => (select value::int from wm.config where key = 'human_check_ttl_h')),
      open_window_count = 0
  where user_id = p_uid;
  return '{"ok": true}';
end $$;

-- Régénération paresseuse (D§7.2). N'écrit que si un paquet revient ou si l'horloge démarre.
create or replace function wm.apply_regen(p_uid uuid)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  v_period int;
  n int;
begin
  -- Verrou du profil (déjà tenu par l'appelant, ordre C4) : n n'est jamais calculé sur une ligne périmée.
  select * into p from public.profiles where id = p_uid for update;
  if p.packs_remaining >= p.pack_cap then
    return p;
  end if;
  -- Stock incomplet sans date (nouveau compte à 1/10, donnée migrée) : l'horloge démarre ici, sans crédit.
  if p.packs_last_regen_at is null then
    update public.profiles set packs_last_regen_at = now() where id = p_uid returning * into p;
    return p;
  end if;
  v_period := (select (value ->> case when p.is_pro or p.is_vip then 'pro' else 'free' end)::int from wm.config where key = 'pack_period_s');
  n := floor(extract(epoch from now() - p.packs_last_regen_at) / v_period);
  if n > 0 then
    update public.profiles set packs_remaining = least(pack_cap, packs_remaining + n),
      packs_last_regen_at = case when packs_remaining + n < pack_cap then packs_last_regen_at + make_interval(secs => n * v_period) end
    where id = p_uid
    returning * into p;
  end if;
  return p;
end $$;

-- Stock plein : null, pas de compte à rebours vers un paquet qui ne viendra pas.
create or replace function wm.next_regen_at(p public.profiles)
returns timestamptz language sql security definer set search_path = '' as $$
  select p.packs_last_regen_at + make_interval(secs => (value ->> case when p.is_pro or p.is_vip then 'pro' else 'free' end)::int)
  from wm.config where key = 'pack_period_s' and p.packs_remaining < p.pack_cap
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
