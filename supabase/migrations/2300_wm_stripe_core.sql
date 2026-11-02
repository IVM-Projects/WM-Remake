-- ADDITIVE : socle Stripe du M6b (D§7.11, G27, G28, G30, G34, G35, G38, G39, C6) — config shop, tables stripe_events, stripe_customers,
-- subscriptions, purchases, stripe_disputes, colonne deleted_accounts.stripe_pending et son trigger, index ; shop_state, grace_status
-- (lectures stable), stripe_checkout_prepare, stripe_customer_set, stripe_portal_prepare. Nouvelles fonctions, rien de redéfini. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : aucun DELETE/UPDATE ici.

insert into wm.config (key, value, note) values
  ('shop', '{"wb_2500": 2500}', 'Wikibidous crédités par article payé (D:618, D:625)')
on conflict do nothing;

-- Tout l'état Stripe vit dans wm (jamais exposé, aucune politique RLS : le revoke de fin suffit). on delete cascade ne joue qu'à une
-- suppression dure de profil, jamais en exploitation (pierre tombale) : il garde les nettoyages des tests possibles.
-- Dédoublonnage des événements par la clé primaire (D:330) : la clé d'idempotence du webhook.
create table if not exists wm.stripe_events (
  id text primary key check (id like 'evt\_%'),
  type text not null,
  created timestamptz not null,
  livemode boolean not null,
  outcome text not null default 'applied' check (outcome in ('applied', 'ignored', 'stale', 'pending', 'unresolved')),
  received_at timestamptz not null default now()
);

-- Un Customer Stripe par joueur, réutilisé (G17).
create table if not exists wm.stripe_customers (
  customer_id text primary key check (customer_id like 'cus\_%'),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Instantané du dernier événement d'abonnement appliqué (G5, G44) ; event_created garde l'ordre.
create table if not exists wm.subscriptions (
  id text primary key check (id like 'sub\_%'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  customer_id text not null,
  status text not null check (status in ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing',
    'unpaid')),
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancel_at timestamptz,
  canceled_at timestamptz,
  latest_invoice_status text check (latest_invoice_status in ('paid', 'payment_failed')),
  latest_invoice_at timestamptz,
  event_created timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Sessions Checkout payées (G18) ; amount en cents ; consent = session.consent.terms_of_service (G17).
create table if not exists wm.purchases (
  session_id text primary key check (session_id like 'cs\_%'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  item text not null check (item in ('pro_monthly', 'wb_2500')),
  amount int not null check (amount >= 0),
  currency text not null,
  consent text,
  wb int not null default 0 check (wb >= 0),
  created_at timestamptz not null default now()
);

-- Litiges (G8) : file du staff, aucune reprise automatique.
create table if not exists wm.stripe_disputes (
  id text primary key check (id like 'dp\_%'),
  charge_id text,
  amount int not null,
  currency text not null,
  reason text,
  status text not null,
  created_at timestamptz not null,
  event_created timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Résiliation Stripe à faire après une suppression de compte (G10, G35) : posé par le trigger ci-dessous, remis à faux après succès.
alter table wm.deleted_accounts add column if not exists stripe_pending boolean not null default false;

-- Option A : CONCURRENTLY par le runbook.
create index if not exists subscriptions_user_idx on wm.subscriptions (user_id);
create index if not exists purchases_user_idx on wm.purchases (user_id, created_at);
create index if not exists stripe_disputes_open_idx on wm.stripe_disputes (created_at desc)
  where status not in ('won', 'lost', 'warning_closed', 'prevented');
create index if not exists deleted_accounts_stripe_pending_idx on wm.deleted_accounts (deleted_at) where stripe_pending;

-- G35 (C2) : drapeau posé dans la transaction de la suppression, avant tout appel Stripe ; un processus tué ensuite le laisse vrai.
-- account_delete tient le profil (lock_users) : un stripe_apply concurrent passe avant (l'abonnement est vu ici) ou après (il voit la
-- pierre tombale et recalcule le drapeau, 2310).
create or replace function wm.stripe_pending_on_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.stripe_pending := exists (select from wm.subscriptions where user_id = new.user_id
    and status in ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'));
  return new;
end $$;

create or replace trigger deleted_accounts_stripe_pending before insert on wm.deleted_accounts
  for each row execute function wm.stripe_pending_on_delete();

-- Boutique, en-tête, /settings, « Comment ça marche ? » (G34, G46). Lecture sans actor : la route fait access_check (403) ; ici 401
-- pour un profil absent ou supprimé. subscription : la plus récente non terminale, sinon la plus récente. purchase : seulement une
-- session de p_uid (retour de Checkout, G33).
create or replace function wm.shop_state(p_uid uuid, p_session text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.profiles;
  c jsonb := (select jsonb_object_agg(key, value) from wm.config where key in ('pack_size', 'pack_period_s', 'pro_daily',
    'max_concurrent_auctions', 'battle', 'sales_detail_window', 'shop', 'maintenance'));
begin
  select * into p from public.profiles where id = p_uid;
  if not found or exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  return jsonb_build_object(
    'rules', jsonb_build_object('pack_size', c -> 'pack_size', 'pack_period_s', c -> 'pack_period_s',
      'pro_daily_size', c -> 'pro_daily' -> 'size', 'max_concurrent_auctions', c -> 'max_concurrent_auctions',
      'battle_quota', jsonb_build_object('free', c -> 'battle' -> 'quota_free', 'pro', c -> 'battle' -> 'quota_pro'),
      'sales_detail_days', c -> 'sales_detail_window' -> 'days', 'wb_2500', c -> 'shop' -> 'wb_2500'),
    'me', jsonb_build_object('balance', p.wikibidous_balance, 'is_pro', p.is_pro, 'is_vip', p.is_vip, 'pack_cap', p.pack_cap,
      'has_customer', exists (select from wm.stripe_customers where user_id = p_uid),
      'subscription', (select jsonb_build_object('status', s.status, 'current_period_end', s.current_period_end,
          'cancel_at_period_end', s.cancel_at_period_end, 'cancel_at', s.cancel_at)
        from wm.subscriptions s where s.user_id = p_uid
        order by s.status in ('canceled', 'incomplete_expired'), s.event_created desc, s.id limit 1)),
    'purchase', (select jsonb_build_object('item', u.item, 'created_at', u.created_at)
      from wm.purchases u where u.session_id = p_session and u.user_id = p_uid),
    'maintenance', coalesce(c -> 'maintenance' = 'true'::jsonb, false));
end $$;

-- Avant la création d'une session Checkout (G9, G17, G41) : aucune écriture, aucun verrou. Rend le Customer à réutiliser et l'e-mail.
-- shortcut: garde de G9 sans verrou ; deux onglets peuvent créer deux abonnements, le second se résilie au Portail. Verrou consultatif par
-- joueur si observé.
create or replace function wm.stripe_checkout_prepare(p_uid uuid, p_item text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform wm.actor(p_uid);
  if p_item is null or p_item not in ('pro_monthly', 'wb_2500') then
    perform wm.raise_err(400, 'invalid_request', 'Article inconnu');
  end if;
  if p_item = 'pro_monthly' and exists (select from wm.subscriptions where user_id = p_uid
      and status in ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')) then
    perform wm.raise_err(409, 'already_subscribed', 'Tu as déjà un abonnement Pro : gère-le depuis les paramètres.');
  end if;
  return jsonb_build_object('customer_id', (select customer_id from wm.stripe_customers where user_id = p_uid),
    'email', (select email from auth.users where id = p_uid));
end $$;

-- Customer créé chez Stripe (G17, G45) : premier posé gagne ; rend celui du joueur (celui d'avant si une autre requête l'a posé).
-- null = le Customer appartient déjà à un autre joueur ; l'appelant (Task 5, route) le traite comme une erreur 502, jamais comme « pas de
-- Customer ».
create or replace function wm.stripe_customer_set(p_uid uuid, p_customer_id text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select from public.profiles where id = p_uid) or exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  perform set_config('lock_timeout', '2s', true);
  insert into wm.stripe_customers (customer_id, user_id) values (p_customer_id, p_uid) on conflict do nothing;
  return (select customer_id from wm.stripe_customers where user_id = p_uid);
end $$;

-- Portail client (G39) : sans wm.actor, un joueur restreint ou suspendu garde le droit de résilier ; maintenance et compte supprimé
-- refusés.
create or replace function wm.stripe_portal_prepare(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_customer text;
begin
  if (select value from wm.config where key = 'maintenance') = 'true'::jsonb then
    perform wm.raise_err(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.');
  end if;
  if not exists (select from public.profiles where id = p_uid) or exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  select customer_id into v_customer from wm.stripe_customers where user_id = p_uid;
  if not found then
    perform wm.raise_err(404, 'no_customer', 'Aucun abonnement à gérer');
  end if;
  return jsonb_build_object('customer_id', v_customer);
end $$;

-- Dotations de grâce en attente (C6) ; size = celle que wm.claim_grace prendra (la plus ancienne). La route fait access_check.
create or replace function wm.grace_status(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('available', count(*),
    'size', (select g.size from wm.grace_grants g where g.user_id = p_uid and g.claimed_at is null order by g.id limit 1))
  from wm.grace_grants where user_id = p_uid and claimed_at is null
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
