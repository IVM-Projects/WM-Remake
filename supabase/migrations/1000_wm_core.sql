-- ADDITIVE : schéma wm, socle de toutes les fonctions qui écrivent (D§6.5, D§7.0, C4–C6, C29). Idempotente.
-- Appelé par le serveur seul (service_role via PostgREST) ; anon et authenticated n'ont aucun accès au schéma.

create schema if not exists wm;

-- Sinon chaque suppression de copie parcourt profiles à cause du on delete set null (D§9.4).
create index if not exists profiles_avatar_user_card_id_idx on public.profiles (avatar_user_card_id)
  where avatar_user_card_id is not null;

create table if not exists wm.config (
  key text primary key,
  value jsonb not null,
  note text
);
insert into wm.config (key, value, note) values ('maintenance', 'false', 'Drapeau opérationnel')
on conflict do nothing;

create table if not exists wm.staff (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  role text not null check (role in ('admin', 'moderator')),
  created_at timestamptz not null default now()
);

create table if not exists wm.sanctions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('warning', 'restriction', 'suspension', 'ban')),
  reason text,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- shortcut: non partitionné (l'unicité globale de la clé l'interdit par date), partitionner au-delà de 20 M de lignes (C5).
create table if not exists wm.wb_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  delta int not null,
  reason text not null,
  ref text not null,
  balance_after int not null,
  created_at timestamptz not null default now(),
  unique (reason, ref, user_id)
);
create index if not exists wb_ledger_user_id_created_at_idx on wm.wb_ledger (user_id, created_at desc);

create table if not exists wm.idempotency_keys (
  user_id uuid not null,
  key text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Erreur métier : route() renvoie detail tel quel avec son statut ; error et message portent la même chaîne.
create or replace function wm.raise_err(p_status int, p_code text, p_message text, p_extra jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_message,
    detail = (jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_message,
                                                   'message', p_message)) || p_extra)::text;
end $$;

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

-- Seul écrivain de wikibidous_balance (C5). Rejeu de (reason, ref) : solde courant, rien ne change.
create or replace function wm.wallet_apply(p_uid uuid, p_delta int, p_reason text, p_ref text)
returns int language plpgsql security definer set search_path = '' as $$
declare v_bal int;
begin
  -- Verrou d'abord (étape 2 de C4, déjà tenu si l'appelant l'a pris) : le solde lu pour l'ouverture n'est jamais périmé.
  select wikibidous_balance into v_bal from public.profiles where id = p_uid for update;
  if not found then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  -- Solde d'avant le grand livre : première écriture du joueur, pour que Σ delta = solde.
  insert into wm.wb_ledger (user_id, delta, reason, ref, balance_after)
  select p_uid, v_bal, 'opening', 'opening', v_bal
  where not exists (select from wm.wb_ledger where user_id = p_uid)
  on conflict do nothing;
  insert into wm.wb_ledger (user_id, delta, reason, ref, balance_after)
  values (p_uid, p_delta, p_reason, p_ref, v_bal + p_delta)
  on conflict do nothing;
  if not found then
    return v_bal;
  end if;
  update public.profiles set wikibidous_balance = wikibidous_balance + p_delta
  where id = p_uid and wikibidous_balance + p_delta >= 0
  returning wikibidous_balance into v_bal;
  if not found then  -- l'exception annule aussi les écritures ci-dessus
    perform wm.raise_err(409, 'insufficient_balance', 'Solde insuffisant');
  end if;
  return v_bal;
end $$;

-- Idempotency-Key (C6) : null → exécuter l'action ; sinon la réponse déjà stockée. Un doublon concurrent attend l'unicité.
create or replace function wm.idem_claim(p_uid uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null then
    return null;
  end if;
  if char_length(p_key) not between 1 and 128 then
    perform wm.raise_err(400, 'invalid_request', 'Idempotency-Key invalide (1 à 128 caractères).');
  end if;
  insert into wm.idempotency_keys (user_id, key) values (p_uid, p_key) on conflict do nothing;
  if found then
    return null;
  end if;
  return (select response from wm.idempotency_keys where user_id = p_uid and key = p_key);
end $$;

create or replace function wm.idem_store(p_uid uuid, p_key text, p_response jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_key is not null then
    update wm.idempotency_keys set response = p_response where user_id = p_uid and key = p_key;
  end if;
  return p_response;
end $$;

create or replace function wm.health()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'db', 'ok', 'now', now())
$$;

-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4).
create or replace function wm.check_invariants()
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(v), '[]') from (
    select jsonb_build_object('check', 'ledger_balance', 'user_id', p.id, 'balance', p.wikibidous_balance, 'ledger_sum', l.s) v
    from public.profiles p
    join (select user_id, sum(delta) s from wm.wb_ledger group by user_id) l on l.user_id = p.id
    where l.s <> p.wikibidous_balance
    union all
    select jsonb_build_object('check', 'negative_balance', 'user_id', p.id)
    from public.profiles p where p.wikibidous_balance < 0
  ) x
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
-- Chaque migration wm finit par ce couple revoke/grant (PG ne sait pas fermer par défaut un seul schéma) ; vérifié par le scan de supabase/tests/10_wm_core.test.sql.
