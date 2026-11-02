-- Socle Stripe (2300_wm_stripe_core.sql) : config shop, tables, drapeau stripe_pending posé à la suppression, shop_state,
-- stripe_checkout_prepare, stripe_customer_set, stripe_portal_prepare, grace_status, VIP = Pro (S:75) ; stripe_apply (2310) ; invariants,
-- export, tableau de bord et résiliation (2320).
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ne filtre que sur eux.
-- check_invariants est global : une violation voulue se fait dans une sous-transaction annulée (WMT00, 27_market.test.sql:278-285) ; un
-- abonnement active ou trialing posé à la main l'est sur un joueur is_pro (invariant stripe_pro, 2320).

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

-- Abonnement posé à la main (les événements arrivent en 2310).
create function pg_temp.sub(p_id text, p_uid uuid, p_status text, p_created timestamptz default now()) returns void language sql as $$
  insert into wm.subscriptions (id, user_id, customer_id, status, event_created) values (p_id, p_uid, 'cus_bench_' || p_id, p_status, p_created)
$$;

-- Événement et objets tels que le webhook les passe à stripe_apply (2310) ; le Customer d'un joueur est cus_bench_<uid sans tirets>.
create function pg_temp.ev(p_id text, p_type text, p_created bigint, p_object jsonb) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'object', 'event', 'type', p_type, 'created', p_created, 'livemode', false,
    'data', jsonb_build_object('object', p_object))
$$;
create function pg_temp.cus(p_uid uuid) returns text language sql as $$ select 'cus_bench_' || replace(p_uid::text, '-', '') $$;
create function pg_temp.sub(p_id text, p_uid uuid, p_status text, p_period_end bigint, p_cancel boolean default false) returns jsonb
language sql as $$
  select jsonb_build_object('id', p_id, 'object', 'subscription', 'customer', pg_temp.cus(p_uid), 'status', p_status,
    'cancel_at_period_end', p_cancel, 'cancel_at', case when p_cancel then p_period_end end, 'canceled_at', null,
    'metadata', jsonb_build_object('uid', p_uid), 'items', jsonb_build_object('data', jsonb_build_array(
      jsonb_build_object('current_period_end', p_period_end, 'price', jsonb_build_object('id', 'price_test_bench_pro')))))
$$;
-- Session Checkout : payment = wb_2500 à 499 cents, subscription = pro_monthly à 999 cents.
create function pg_temp.cs(p_id text, p_uid uuid, p_mode text, p_paid text default 'paid') returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'object', 'checkout.session', 'mode', p_mode, 'payment_status', p_paid, 'client_reference_id', p_uid,
    'customer', pg_temp.cus(p_uid), 'metadata', jsonb_build_object('uid', p_uid, 'item', case p_mode when 'payment' then 'wb_2500' else 'pro_monthly' end),
    'amount_total', case p_mode when 'payment' then 499 else 999 end, 'currency', 'cad', 'consent', jsonb_build_object('terms_of_service', 'accepted'))
$$;
create function pg_temp.ap(p_event jsonb) returns text language sql as $$ select wm.stripe_apply(p_event) ->> 'outcome' $$;
create function pg_temp.pro(p_uid uuid) returns boolean language sql as $$ select is_pro from public.profiles where id = p_uid $$;
create function pg_temp.n(p_uid uuid, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where user_id = p_uid and type = p_type
$$;
create function pg_temp.bal(p_uid uuid) returns int language sql as $$ select wikibidous_balance from public.profiles where id = p_uid $$;

select pg_temp.inv('début de 40');

-- Config shop (G28) et sa note ; rejeu de 2300, deux fois : mêmes valeurs, une valeur posée survit.
do $$ begin
  assert (select value from wm.config where key = 'shop') = '{"wb_2500": 2500}'::jsonb, 'shop';
  assert (select coalesce(note, '') <> '' from wm.config where key = 'shop'), 'note de shop';
  update wm.config set value = '{"wb_2500": 10}' where key = 'shop';
end $$;
\ir ../migrations/2300_wm_stripe_core.sql
\ir ../migrations/2300_wm_stripe_core.sql
do $$ begin
  assert (select value from wm.config where key = 'shop') = '{"wb_2500": 10}'::jsonb, 'valeur posée écrasée par le rejeu';
  assert (select count(*) from wm.config where key = 'shop') = 1, 'une ligne shop';
  update wm.config set value = '{"wb_2500": 2500}' where key = 'shop';
end $$;

-- Rejeu de 2310 (stripe_uid, stripe_apply), deux fois : create or replace seulement, rien d'autre ne bouge.
\ir ../migrations/2310_wm_stripe_apply.sql
\ir ../migrations/2310_wm_stripe_apply.sql
do $$ begin
  assert (select count(*) from pg_proc where pronamespace = 'wm'::regnamespace and proname in ('stripe_uid', 'stripe_apply')) = 2, '2310';
  assert (select array_agg(format('%s:%s:%s:%s', proname, prosecdef, provolatile, proconfig) order by proname)
    from pg_proc where pronamespace = 'wm'::regnamespace and proname in ('stripe_uid', 'stripe_apply'))
    = array['stripe_apply:t:v:{"search_path=\"\""}', 'stripe_uid:t:s:{"search_path=\"\""}'], 'réglages des fonctions';
end $$;

-- Rejeu de 2250, 2260 et 2240 suivi de 2320 (M5b-18), puis 2320 une seconde fois : les trois fonctions redéfinies retrouvent le corps de
-- 2320 ; réglages des six fonctions de 2320.
create temp table stripe_ops_src as select proname, md5(prosrc) h from pg_proc
  where pronamespace = 'wm'::regnamespace and proname in ('check_invariants', 'account_export', 'staff_dashboard');
\ir ../migrations/2250_wm_account_delete.sql
\ir ../migrations/2260_wm_account_export.sql
\ir ../migrations/2240_wm_guild_moderation.sql
\ir ../migrations/2320_wm_stripe_ops.sql
\ir ../migrations/2320_wm_stripe_ops.sql
do $$ begin
  assert (select count(*) from stripe_ops_src) = 3 and not exists (select from stripe_ops_src s join pg_proc p on p.proname = s.proname
    and p.pronamespace = 'wm'::regnamespace where md5(p.prosrc) <> s.h), 'corps changé par le rejeu';
  assert (select bool_and(strpos(prosrc, k) > 0) from pg_proc, unnest(array['stripe_purchase', 'stripe_pro']) k
    where oid = to_regproc('wm.check_invariants')), 'check_invariants de 2320';
  assert (select array_agg(format('%s:%s:%s:%s', proname, prosecdef, provolatile, proconfig) order by proname)
    from pg_proc where pronamespace = 'wm'::regnamespace and proname in ('check_invariants', 'account_export', 'staff_dashboard',
      'stripe_cancel_targets', 'stripe_cancel_done', 'admin_stripe_cancel'))
    = array['account_export:t:v:{"search_path=\"\""}', 'admin_stripe_cancel:t:v:{"search_path=\"\""}',
      'check_invariants:t:v:{"search_path=\"\""}', 'staff_dashboard:t:s:{"search_path=\"\""}',
      'stripe_cancel_done:t:v:{"search_path=\"\""}', 'stripe_cancel_targets:t:s:{"search_path=\"\""}'], 'réglages des fonctions de 2320';
end $$;

-- Colonnes, contraintes et index (G27), définitions complètes.
do $$ declare bad text; begin
  select string_agg(v.t, ', ') into bad from (values
    ('stripe_events', 'id text NO , type text NO , created timestamptz NO , livemode bool NO , outcome text NO ''applied''::text, received_at timestamptz NO now()'),
    ('stripe_customers', 'customer_id text NO , user_id uuid NO , created_at timestamptz NO now()'),
    ('subscriptions', 'id text NO , user_id uuid NO , customer_id text NO , status text NO , price_id text YES , current_period_end timestamptz YES , cancel_at_period_end bool NO false, cancel_at timestamptz YES , canceled_at timestamptz YES , latest_invoice_status text YES , latest_invoice_at timestamptz YES , event_created timestamptz NO , updated_at timestamptz NO now()'),
    ('purchases', 'session_id text NO , user_id uuid NO , item text NO , amount int4 NO , currency text NO , consent text YES , wb int4 NO 0, created_at timestamptz NO now()'),
    ('stripe_disputes', 'id text NO , charge_id text YES , amount int4 NO , currency text NO , reason text YES , status text NO , created_at timestamptz NO , event_created timestamptz NO , updated_at timestamptz NO now()')) v (t, cols)
  where v.cols is distinct from (select string_agg(format('%s %s %s %s', column_name, udt_name, is_nullable, coalesce(column_default, '')), ', '
    order by ordinal_position) from information_schema.columns where table_schema = 'wm' and table_name = v.t);
  assert bad is null, 'colonnes différentes : ' || bad;
  select string_agg(v.n, ', ') into bad from (values
    ('purchases_amount_check', 'CHECK ((amount >= 0))'),
    ('purchases_item_check', 'CHECK ((item = ANY (ARRAY[''pro_monthly''::text, ''wb_2500''::text])))'),
    ('purchases_session_id_check', 'CHECK ((session_id ~~ ''cs\_%''::text))'),
    ('purchases_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE'),
    ('purchases_wb_check', 'CHECK ((wb >= 0))'),
    ('stripe_customers_customer_id_check', 'CHECK ((customer_id ~~ ''cus\_%''::text))'),
    ('stripe_customers_pkey', 'PRIMARY KEY (customer_id)'),
    ('stripe_customers_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE'),
    ('stripe_customers_user_id_key', 'UNIQUE (user_id)'),
    ('stripe_disputes_id_check', 'CHECK ((id ~~ ''dp\_%''::text))'),
    ('stripe_disputes_pkey', 'PRIMARY KEY (id)'),
    ('stripe_events_id_check', 'CHECK ((id ~~ ''evt\_%''::text))'),
    ('stripe_events_outcome_check', 'CHECK ((outcome = ANY (ARRAY[''applied''::text, ''ignored''::text, ''stale''::text, ''pending''::text, ''unresolved''::text])))'),
    ('subscriptions_id_check', 'CHECK ((id ~~ ''sub\_%''::text))'),
    ('subscriptions_latest_invoice_status_check', 'CHECK ((latest_invoice_status = ANY (ARRAY[''paid''::text, ''payment_failed''::text])))'),
    ('subscriptions_pkey', 'PRIMARY KEY (id)'),
    ('subscriptions_status_check', 'CHECK ((status = ANY (ARRAY[''active''::text, ''canceled''::text, ''incomplete''::text, ''incomplete_expired''::text, ''past_due''::text, ''paused''::text, ''trialing''::text, ''unpaid''::text])))'),
    ('subscriptions_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE')) v (n, def)
  where not exists (select from pg_constraint c where c.conname = v.n and c.connamespace = 'wm'::regnamespace
    and pg_get_constraintdef(c.oid) = v.def);
  assert bad is null, 'contraintes absentes ou différentes : ' || bad;
  assert (select count(*) from pg_constraint where conrelid in ('wm.stripe_events'::regclass, 'wm.stripe_customers'::regclass,
    'wm.subscriptions'::regclass, 'wm.purchases'::regclass, 'wm.stripe_disputes'::regclass) and contype <> 'n') = 20, 'contraintes en trop';
  select string_agg(v.n, ', ') into bad from (values
    ('subscriptions_user_idx', 'wm.subscriptions USING btree (user_id)'),
    ('purchases_user_idx', 'wm.purchases USING btree (user_id, created_at)'),
    ('stripe_disputes_open_idx', 'wm.stripe_disputes USING btree (created_at DESC) WHERE (status <> ALL (ARRAY[''won''::text, ''lost''::text, ''warning_closed''::text, ''prevented''::text]))'),
    ('deleted_accounts_stripe_pending_idx', 'wm.deleted_accounts USING btree (deleted_at) WHERE stripe_pending')) v (n, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef = format('CREATE INDEX %s ON %s', v.n, v.def));
  assert bad is null, 'index absents ou différents : ' || bad;
  assert (select format('%s %s %s', udt_name, is_nullable, column_default) from information_schema.columns
    where table_schema = 'wm' and table_name = 'deleted_accounts' and column_name = 'stripe_pending') = 'bool NO false', 'stripe_pending';
  assert not exists (select from pg_policies where schemaname = 'wm'), 'politique RLS dans wm';
end $$;

-- Structure (C3, G25 c) : unicité des événements, des achats et des crédits prouvée par contrainte.
do $$ declare raised boolean := false; begin
  assert exists (select from pg_constraint where conname = 'stripe_events_pkey' and conrelid = 'wm.stripe_events'::regclass
    and pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'), 'stripe_events_pkey';
  assert exists (select from pg_constraint where conname = 'purchases_pkey' and conrelid = 'wm.purchases'::regclass
    and pg_get_constraintdef(oid) = 'PRIMARY KEY (session_id)'), 'purchases_pkey';
  assert exists (select from pg_constraint where conrelid = 'wm.wb_ledger'::regclass and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (reason, ref, user_id)'), 'clé unique du grand livre';
  insert into wm.stripe_events (id, type, created, livemode) values ('evt_bench_1', 'checkout.session.completed', now(), false);
  begin
    insert into wm.stripe_events (id, type, created, livemode) values ('evt_bench_1', 'checkout.session.completed', now(), false);
  exception when unique_violation then
    raised := true;
  end;
  assert raised, 'second evt_bench_1 accepté';
  assert (select outcome from wm.stripe_events where id = 'evt_bench_1') = 'applied', 'outcome par défaut';
end $$;

-- Review Focus, abonné supprimé (G35) : le trigger pose stripe_pending selon un abonnement non terminal.
do $$ declare a uuid := tests.make_user('StrDelA'); c uuid := tests.make_user('StrDelC'); p uuid := tests.make_user('StrDelP');
  n uuid := tests.make_user('StrDelN'); begin
  update public.profiles set is_pro = true where id = a;
  perform pg_temp.sub('sub_bench_del_a', a, 'active');
  perform pg_temp.sub('sub_bench_del_c', c, 'canceled');
  perform pg_temp.sub('sub_bench_del_p', p, 'past_due');
  insert into wm.deleted_accounts (user_id) values (a), (c), (p), (n);
  assert (select jsonb_object_agg(user_id, stripe_pending) from wm.deleted_accounts where user_id in (a, c, p, n))
    = jsonb_build_object(a, true, c, false, p, true, n, false), 'stripe_pending';
  perform pg_temp.inv('pierres tombales');
end $$;

-- shop_state (G34, G46).
do $$ declare u uuid := tests.make_user('StrShop', 120); o uuid := tests.make_user('StrShopO'); d uuid := tests.make_user('StrShopD');
  r jsonb; begin
  r := wm.shop_state(u);
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['maintenance', 'me', 'purchase', 'rules'], 'clés';
  assert r -> 'rules' = '{"pack_size": 5, "pack_period_s": {"free": 600, "pro": 180}, "pro_daily_size": 15,
    "max_concurrent_auctions": {"free": 5, "pro": 10}, "battle_quota": {"free": 3, "pro": 10}, "sales_detail_days": 30,
    "wb_2500": 2500}'::jsonb, r -> 'rules';
  assert r -> 'me' = jsonb_build_object('balance', 120, 'is_pro', false, 'is_vip', false,
    'pack_cap', (select pack_cap from public.profiles where id = u), 'has_customer', false, 'subscription', null), r -> 'me';
  assert r -> 'purchase' = 'null' and r -> 'maintenance' = 'false', r::text;
  update wm.config set value = 'true' where key = 'maintenance';
  assert wm.shop_state(u) -> 'maintenance' = 'true', 'maintenance suivie';
  update wm.config set value = 'false' where key = 'maintenance';
  -- La plus récente non terminale l'emporte sur une canceled plus récente.
  update public.profiles set is_pro = true where id = u;
  perform pg_temp.sub('sub_bench_shop_old', u, 'active', now() - interval '2 days');
  perform pg_temp.sub('sub_bench_shop_new', u, 'canceled', now() - interval '1 day');
  update wm.subscriptions set current_period_end = now() + interval '30 days', cancel_at_period_end = true,
    cancel_at = now() + interval '30 days' where id = 'sub_bench_shop_old';
  insert into wm.stripe_customers (customer_id, user_id) values ('cus_bench_shop', u);
  r := wm.shop_state(u) -> 'me';
  assert r -> 'subscription' = jsonb_build_object('status', 'active', 'current_period_end', now() + interval '30 days',
    'cancel_at_period_end', true, 'cancel_at', now() + interval '30 days'), r::text;
  assert r -> 'has_customer' = 'true' and r -> 'is_pro' = 'true', r::text;
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k)
    = array['balance', 'has_customer', 'is_pro', 'is_vip', 'pack_cap', 'subscription'], 'clés de me';
  -- Deux non terminaux (deux onglets, G41) : le plus récent par event_created.
  perform pg_temp.sub('sub_bench_shop_two', u, 'past_due', now() - interval '1 hour');
  assert wm.shop_state(u) -> 'me' -> 'subscription' ->> 'status' = 'past_due', 'deux non terminaux';
  delete from wm.subscriptions where id = 'sub_bench_shop_two';
  -- Seule la canceled : rendue.
  perform pg_temp.sub('sub_bench_shop_o', o, 'canceled');
  assert wm.shop_state(o) -> 'me' -> 'subscription' ->> 'status' = 'canceled', 'terminale seule';
  -- purchase : seulement une session du joueur.
  insert into wm.purchases (session_id, user_id, item, amount, currency, wb) values ('cs_test_bench_shop', u, 'pro_monthly', 999, 'cad', 0);
  assert wm.shop_state(u, 'cs_test_bench_shop') -> 'purchase' = jsonb_build_object('item', 'pro_monthly', 'created_at', now()), 'purchase';
  assert wm.shop_state(o, 'cs_test_bench_shop') -> 'purchase' = 'null', 'session d''un autre joueur';
  assert wm.shop_state(u, 'cs_test_bench_inconnue') -> 'purchase' = 'null', 'session inconnue';
  insert into wm.deleted_accounts (user_id) values (d);
  assert pg_temp.err(format('select wm.shop_state(%L)', d))
    = '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}', 'supprimé';
  assert pg_temp.err(format('select wm.shop_state(%L)', gen_random_uuid())) ->> 'status' = '401', 'profil absent';
  assert (select provolatile from pg_proc where oid = to_regproc('wm.shop_state')) = 's', 'shop_state volatile';
  assert (select provolatile from pg_proc where oid = to_regproc('wm.grace_status')) = 's', 'grace_status volatile';
  perform pg_temp.inv('shop_state');
end $$;

-- stripe_checkout_prepare (G9, G38) : wm.actor, article, abonnement non terminal ; aucune écriture.
do $$ declare u uuid := tests.make_user('StrCo'); w uuid := tests.make_user('StrCoW'); r uuid := tests.make_user('StrCoR');
  d uuid := tests.make_user('StrCoD'); q text := 'select wm.stripe_checkout_prepare(%L, %L)'; s text; e jsonb;
  dup jsonb := '{"status":409,"code":"already_subscribed","error":"Tu as déjà un abonnement Pro : gère-le depuis les paramètres.","message":"Tu as déjà un abonnement Pro : gère-le depuis les paramètres."}';
  begin
  assert pg_temp.err(format(q, u, 'x'))
    = '{"status":400,"code":"invalid_request","error":"Article inconnu","message":"Article inconnu"}', 'article inconnu';
  assert pg_temp.err(format(q, u, null)) ->> 'error' = 'Article inconnu', 'article nul';
  assert wm.stripe_checkout_prepare(u, 'pro_monthly') = jsonb_build_object('customer_id', null, 'email', u || '@test.local'), 'sans rien';
  update public.profiles set is_pro = true where id = u;
  perform pg_temp.sub('sub_bench_co', u, 'active');
  foreach s in array array['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'] loop
    update wm.subscriptions set status = s where id = 'sub_bench_co';
    assert pg_temp.err(format(q, u, 'pro_monthly')) = dup, s;
  end loop;
  update wm.subscriptions set status = 'active' where id = 'sub_bench_co';
  assert wm.stripe_checkout_prepare(u, 'wb_2500') ->> 'email' = u || '@test.local', 'wb_2500 avec un active';
  update public.profiles set is_pro = false where id = u;
  foreach s in array array['canceled', 'incomplete_expired'] loop
    update wm.subscriptions set status = s where id = 'sub_bench_co';
    assert pg_temp.err(format(q, u, 'pro_monthly')) is null, s;
  end loop;
  insert into wm.stripe_customers (customer_id, user_id) values ('cus_bench_co', u);
  assert wm.stripe_checkout_prepare(u, 'pro_monthly') = jsonb_build_object('customer_id', 'cus_bench_co', 'email', u || '@test.local'),
    'Customer rendu';
  update auth.users set email = 'neuf@test.local' where id = w;
  assert wm.stripe_checkout_prepare(w, 'wb_2500') ->> 'email' = 'neuf@test.local', 'e-mail de auth.users';
  update wm.config set value = 'true' where key = 'maintenance';
  assert pg_temp.err(format(q, w, 'wb_2500')) = '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.","message":"Maintenance en cours, reviens dans quelques minutes."}', 'maintenance';
  update wm.config set value = 'false' where key = 'maintenance';
  insert into wm.sanctions (user_id, kind, reason) values (r, 'restriction', 'test');
  e := pg_temp.err(format(q, r, 'wb_2500'));
  assert e ->> 'status' = '403' and e ->> 'error' = 'Ton compte est temporairement restreint.', coalesce(e::text, 'acceptée');
  insert into wm.deleted_accounts (user_id) values (d);
  assert pg_temp.err(format(q, d, 'wb_2500'))
    = '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}', 'supprimé';
  assert not exists (select from wm.stripe_customers where user_id in (w, r, d)), 'aucune écriture';
  perform pg_temp.inv('checkout_prepare');
end $$;

-- stripe_customer_set (G17, G45) : premier posé gagne.
do $$ declare u uuid := tests.make_user('StrCus'); d uuid := tests.make_user('StrCusD'); q text := 'select wm.stripe_customer_set(%L, %L)';
  e jsonb := '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}';
  begin
  assert wm.stripe_customer_set(u, 'cus_bench_a') = 'cus_bench_a', 'premier';
  assert wm.stripe_customer_set(u, 'cus_bench_b') = 'cus_bench_a', 'second';
  assert (select count(*) from wm.stripe_customers where user_id = u) = 1
    and not exists (select from wm.stripe_customers where customer_id = 'cus_bench_b'), 'une seule ligne';
  insert into wm.deleted_accounts (user_id) values (d);
  assert pg_temp.err(format(q, d, 'cus_bench_d')) = e, 'supprimé';
  assert pg_temp.err(format(q, gen_random_uuid(), 'cus_bench_x')) = e, 'profil absent';
  assert not exists (select from wm.stripe_customers where customer_id in ('cus_bench_d', 'cus_bench_x')), 'aucune écriture';
end $$;

-- stripe_portal_prepare (G39) : sans wm.actor, une restriction passe.
do $$ declare u uuid := tests.make_user('StrPo'); d uuid := tests.make_user('StrPoD'); q text := 'select wm.stripe_portal_prepare(%L)'; begin
  assert pg_temp.err(format(q, u))
    = '{"status":404,"code":"no_customer","error":"Aucun abonnement à gérer","message":"Aucun abonnement à gérer"}', 'sans Customer';
  insert into wm.stripe_customers (customer_id, user_id) values ('cus_bench_po', u), ('cus_bench_pod', d);
  assert wm.stripe_portal_prepare(u) = '{"customer_id": "cus_bench_po"}', 'avec Customer';
  insert into wm.sanctions (user_id, kind, reason) values (u, 'restriction', 'test'), (u, 'suspension', 'test');
  assert wm.stripe_portal_prepare(u) = '{"customer_id": "cus_bench_po"}', 'sanction';
  update wm.config set value = 'true' where key = 'maintenance';
  assert pg_temp.err(format(q, u)) = '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.","message":"Maintenance en cours, reviens dans quelques minutes."}', 'maintenance';
  update wm.config set value = 'false' where key = 'maintenance';
  insert into wm.deleted_accounts (user_id) values (d);
  assert pg_temp.err(format(q, d))
    = '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}', 'supprimé';
  assert pg_temp.err(format(q, gen_random_uuid()))
    = '{"status":401,"code":"unauthorized","error":"Session expirée, reconnecte-toi.","message":"Session expirée, reconnecte-toi."}', 'profil absent';
end $$;

-- grace_status (C6) : dotations non réclamées, taille de la plus ancienne (celle que claim_grace prend).
do $$ declare u uuid := tests.make_user('StrGrace'); begin
  assert wm.grace_status(u) = '{"available": 0, "size": null}', 'aucune';
  insert into wm.grace_grants (user_id, size) values (u, 7);
  insert into wm.grace_grants (user_id, size) values (u, 5);
  assert wm.grace_status(u) = '{"available": 2, "size": 7}', 'deux';
  update wm.grace_grants set claimed_at = now() where id = (select min(id) from wm.grace_grants where user_id = u);
  assert wm.grace_status(u) = '{"available": 1, "size": 5}', 'une réclamée';
end $$;

-- S:75 (VIP = Pro) : un VIP sans is_pro a le paquet Pro du jour, la régénération Pro et la limite Pro des ventes (dette S:247).
do $$ declare v uuid := tests.make_user('StrVip'); c uuid; k public.user_cards; p public.profiles; begin
  update public.profiles set is_vip = true, is_pro = false where id = v;
  assert wm.pro_daily_status(v, 'UTC') ->> 'is_pro' = 'true' and wm.pro_daily_status(v, 'UTC') ->> 'eligible' = 'true',
    wm.pro_daily_status(v, 'UTC')::text;
  update public.profiles set packs_remaining = 0, packs_last_regen_at = now() where id = v returning * into p;
  assert wm.next_regen_at(p) = now() + interval '180 seconds', 'régénération Pro';
  perform wm.set_human_verified(v);
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Vente VIP', 'https://fr.wikipedia.org/wiki/Vente_VIP', 'R', 10, 10) returning id into c;
  for i in 1 .. 6 loop
    k := wm.grant_copy(v, c, false);
    update wm.user_state set list_window_count = 0 where user_id = v;
    perform wm.create_auction(v, k.id, 10, 60);
  end loop;
  assert (select count(*) from public.auctions where seller_id = v and status = 'active') = 6, 'sixième vente';
  perform pg_temp.inv('VIP');
end $$;

-- Review Focus, double crédit (D:625, G18, G29) : le même événement rejoué, puis completed + async_payment_succeeded d'une même session
-- → un seul +2 500 sous stripe:<session_id>, un achat, une wb_purchased.
do $$ declare a uuid := tests.make_user('StrApC', 100); T bigint := extract(epoch from now())::bigint; e jsonb; begin
  e := pg_temp.ev('evt_bench_c1', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_1', a, 'payment'));
  assert wm.stripe_apply(e) = '{"duplicate": false, "outcome": "applied"}', 'premier';
  assert pg_temp.bal(a) = 2600, 'solde';
  assert (select jsonb_agg(jsonb_build_object('delta', delta, 'reason', reason, 'ref', ref, 'balance_after', balance_after))
    from wm.wb_ledger where user_id = a and reason <> 'opening')
    = '[{"delta": 2500, "reason": "stripe", "ref": "stripe:cs_test_bench_1", "balance_after": 2600}]', 'grand livre';
  assert (select jsonb_agg(to_jsonb(p) - 'created_at') from wm.purchases p where user_id = a) = jsonb_build_array(jsonb_build_object(
    'session_id', 'cs_test_bench_1', 'user_id', a, 'item', 'wb_2500', 'amount', 499, 'currency', 'cad', 'consent', 'accepted', 'wb', 2500)),
    'achat';
  assert (select jsonb_agg(jsonb_build_object('type', type, 'data', data)) from public.notifications where user_id = a)
    = '[{"type": "wb_purchased", "data": {"amount": 2500, "session_id": "cs_test_bench_1"}}]', 'notification';
  assert (select to_jsonb(s) - 'received_at' from wm.stripe_events s where id = 'evt_bench_c1') = jsonb_build_object('id', 'evt_bench_c1',
    'type', 'checkout.session.completed', 'created', to_timestamp(T), 'livemode', false, 'outcome', 'applied'), 'ligne stripe_events';
  assert (select user_id from wm.stripe_customers where customer_id = pg_temp.cus(a)) = a, 'lien Customer';
  -- Rejeu du même event.id : rien.
  assert wm.stripe_apply(e) = '{"duplicate": true, "outcome": null}', 'rejeu';
  -- async_payment_succeeded de la même session (autre event.id) : appliqué, aucun second crédit.
  assert wm.stripe_apply(pg_temp.ev('evt_bench_c2', 'checkout.session.async_payment_succeeded', T + 5,
    pg_temp.cs('cs_test_bench_1', a, 'payment'))) = '{"duplicate": false, "outcome": "applied"}', 'async';
  assert pg_temp.bal(a) = 2600 and (select count(*) from wm.wb_ledger where user_id = a and reason = 'stripe') = 1
    and (select count(*) from wm.purchases where user_id = a) = 1 and pg_temp.n(a, 'wb_purchased') = 1
    and (select count(*) from public.notifications where user_id = a) = 1, 'second crédit';
  perform pg_temp.inv('double crédit');
end $$;

-- Paiement non abouti (G29) : pending sans crédit ; async_payment_succeeded payé ensuite → crédit unique.
do $$ declare a uuid := tests.make_user('StrApU'); T bigint := extract(epoch from now())::bigint; begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_u1', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_u', a, 'payment', 'unpaid')))
    = 'pending', 'non payé';
  assert (select outcome from wm.stripe_events where id = 'evt_bench_u1') = 'pending', 'outcome stocké';
  assert pg_temp.bal(a) = 0 and not exists (select from wm.purchases where user_id = a)
    and not exists (select from wm.wb_ledger where user_id = a and reason = 'stripe') and pg_temp.n(a, 'wb_purchased') = 0, 'rien';
  assert pg_temp.ap(pg_temp.ev('evt_bench_u2', 'checkout.session.async_payment_succeeded', T + 60,
    pg_temp.cs('cs_test_bench_u', a, 'payment'))) = 'applied', 'payé';
  assert pg_temp.ap(pg_temp.ev('evt_bench_u3', 'checkout.session.async_payment_succeeded', T + 61,
    pg_temp.cs('cs_test_bench_u', a, 'payment'))) = 'applied', 'payé, seconde livraison';
  assert pg_temp.bal(a) = 2500 and (select count(*) from wm.wb_ledger where user_id = a and reason = 'stripe') = 1
    and (select count(*) from wm.purchases where user_id = a) = 1 and pg_temp.n(a, 'wb_purchased') = 1, 'crédit unique';
  perform pg_temp.inv('non payé');
end $$;

-- Mode abonnement (G29) : achat pro_monthly (wb 0), lien Customer, Pro inchangé (il vient des événements d'abonnement).
do $$ declare a uuid := tests.make_user('StrApM'); T bigint := extract(epoch from now())::bigint; begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_m1', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_m', a, 'subscription')))
    = 'applied', 'abonnement';
  assert (select jsonb_agg(to_jsonb(p) - 'created_at') from wm.purchases p where user_id = a) = jsonb_build_array(jsonb_build_object(
    'session_id', 'cs_test_bench_m', 'user_id', a, 'item', 'pro_monthly', 'amount', 999, 'currency', 'cad', 'consent', 'accepted', 'wb', 0)),
    'achat pro_monthly';
  assert not pg_temp.pro(a) and pg_temp.bal(a) = 0 and not exists (select from wm.wb_ledger where user_id = a)
    and not exists (select from public.notifications where user_id = a), 'rien d''autre';
  assert (select user_id from wm.stripe_customers where customer_id = pg_temp.cus(a)) = a, 'lien Customer';
  perform pg_temp.inv('mode abonnement');
end $$;

-- Review Focus, Pro allumé (G4, G5) : subscription.created active avant tout Checkout et sans lien Customer, résolu par metadata.uid.
do $$ declare a uuid := tests.make_user('StrOnA'); b uuid := tests.make_user('StrOnB'); T bigint := extract(epoch from now())::bigint;
  P bigint := T + 30 * 86400; begin
  assert not exists (select from wm.stripe_customers where user_id = a), 'aucun lien avant';
  assert pg_temp.ap(pg_temp.ev('evt_bench_p1', 'customer.subscription.created', T, pg_temp.sub('sub_bench_p1', a, 'active', P)))
    = 'applied', 'created';
  assert pg_temp.pro(a), 'Pro allumé';
  assert (select jsonb_agg(jsonb_build_object('type', type, 'data', data)) from public.notifications where user_id = a)
    = '[{"type": "pro_started", "data": {"subscription_id": "sub_bench_p1"}}]', 'pro_started';
  assert (select to_jsonb(s) - 'updated_at' from wm.subscriptions s where id = 'sub_bench_p1') = jsonb_build_object('id', 'sub_bench_p1',
    'user_id', a, 'customer_id', pg_temp.cus(a), 'status', 'active', 'price_id', 'price_test_bench_pro', 'current_period_end',
    to_timestamp(P), 'cancel_at_period_end', false, 'cancel_at', null, 'canceled_at', null, 'latest_invoice_status', null,
    'latest_invoice_at', null, 'event_created', to_timestamp(T)), 'ligne subscriptions';
  assert (select user_id from wm.stripe_customers where customer_id = pg_temp.cus(a)) = a, 'lien Customer posé';
  -- Le Checkout arrive ensuite : achat, Pro gardé, aucune notification de plus.
  assert pg_temp.ap(pg_temp.ev('evt_bench_p1b', 'checkout.session.completed', T + 1, pg_temp.cs('cs_test_bench_p1', a, 'subscription')))
    = 'applied', 'Checkout après';
  assert pg_temp.pro(a) and (select count(*) from public.notifications where user_id = a) = 1, 'Pro gardé';
  assert pg_temp.ap(pg_temp.ev('evt_bench_p2', 'customer.subscription.created', T, pg_temp.sub('sub_bench_p2', b, 'trialing', P)))
    = 'applied', 'trialing';
  assert pg_temp.pro(b) and pg_temp.n(b, 'pro_started') = 1, 'trialing → Pro';
  perform pg_temp.inv('Pro allumé');
end $$;

-- Review Focus, Pro éteint (G4, G5, G44) : past_due, retour à active, cancel_at_period_end, deleted ; un instantané plus ancien est
-- stale ; un même-seconde est réappliqué sur un statut non terminal (G44) ; chaque statut → is_pro ; is_vip jamais touché.
do $$ declare a uuid := tests.make_user('StrOffA'); d uuid := tests.make_user('StrOffD'); T bigint := extract(epoch from now())::bigint;
  P bigint := T + 30 * 86400; r jsonb; s text; begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_o1', 'customer.subscription.created', T, pg_temp.sub('sub_bench_off', a, 'active', P)))
    = 'applied', 'o1';
  assert pg_temp.ap(pg_temp.ev('evt_bench_o2', 'customer.subscription.updated', T + 10, pg_temp.sub('sub_bench_off', a, 'past_due', P)))
    = 'applied', 'o2';
  assert not pg_temp.pro(a) and pg_temp.n(a, 'pro_ended') = 1, 'past_due → pas Pro';
  assert (select jsonb_agg(data) from public.notifications where user_id = a and type = 'pro_ended') = '[{"subscription_id": "sub_bench_off"}]',
    'données de pro_ended';
  assert pg_temp.ap(pg_temp.ev('evt_bench_o3', 'customer.subscription.updated', T + 20, pg_temp.sub('sub_bench_off', a, 'active', P)))
    = 'applied', 'o3';
  assert pg_temp.pro(a) and pg_temp.n(a, 'pro_started') = 2, 'active revenu';
  assert pg_temp.ap(pg_temp.ev('evt_bench_o4', 'customer.subscription.updated', T + 30, pg_temp.sub('sub_bench_off', a, 'active', P, true)))
    = 'applied', 'o4';
  assert pg_temp.pro(a) and (select cancel_at_period_end and cancel_at = to_timestamp(P) from wm.subscriptions where id = 'sub_bench_off'),
    'cancel_at_period_end garde Pro';
  -- Même seconde, statut stocké non terminal : réappliqué.
  assert pg_temp.ap(pg_temp.ev('evt_bench_o4b', 'customer.subscription.updated', T + 30, pg_temp.sub('sub_bench_off', a, 'active', P)))
    = 'applied', 'même seconde réappliquée';
  assert (select not cancel_at_period_end and cancel_at is null from wm.subscriptions where id = 'sub_bench_off'), 'réappliqué';
  assert pg_temp.ap(pg_temp.ev('evt_bench_o5', 'customer.subscription.deleted', T + 40, pg_temp.sub('sub_bench_off', a, 'canceled', P)))
    = 'applied', 'deleted';
  assert not pg_temp.pro(a) and pg_temp.n(a, 'pro_ended') = 2, 'deleted → pas Pro';
  r := (select to_jsonb(x) from wm.subscriptions x where id = 'sub_bench_off');
  assert pg_temp.ap(pg_temp.ev('evt_bench_o6', 'customer.subscription.updated', T + 30, pg_temp.sub('sub_bench_off', a, 'active', P)))
    = 'stale', 'plus ancien';
  assert (select outcome from wm.stripe_events where id = 'evt_bench_o6') = 'stale', 'stale stocké';
  assert not pg_temp.pro(a) and (select to_jsonb(x) from wm.subscriptions x where id = 'sub_bench_off') = r, 'ligne inchangée';
  assert (select count(*) from public.notifications where user_id = a) = 4, 'aucune notification de plus';
  -- Chaque statut (G4), sur un VIP : is_vip n'est ni lu ni écrit.
  update public.profiles set is_vip = true where id = d;
  foreach s in array array['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'] loop
    assert pg_temp.ap(pg_temp.ev('evt_bench_st_' || s || '_1', 'customer.subscription.created', T, pg_temp.sub('sub_bench_st_' || s, d,
      'active', P))) = 'applied' and pg_temp.pro(d), s || ' : active d''abord';
    assert pg_temp.ap(pg_temp.ev('evt_bench_st_' || s || '_2', 'customer.subscription.updated', T + 1, pg_temp.sub('sub_bench_st_' || s, d,
      s, P))) = 'applied', s;
    assert pg_temp.pro(d) = (s in ('active', 'trialing')), s || ' → is_pro';
    assert pg_temp.ap(pg_temp.ev('evt_bench_st_' || s || '_3', 'customer.subscription.deleted', T + 2, pg_temp.sub('sub_bench_st_' || s, d,
      'canceled', P))) = 'applied' and not pg_temp.pro(d), s || ' : deleted';
  end loop;
  assert (select is_vip from public.profiles where id = d), 'is_vip écrasé';
  assert (select prosrc from pg_proc where oid = to_regproc('wm.stripe_apply')) not like '%is_vip%', 'is_vip lu ou écrit';
  perform pg_temp.inv('Pro éteint');
end $$;

-- Review Focus, départage à égalité de seconde (G44).
do $$ declare a uuid := tests.make_user('StrTieA'); b uuid := tests.make_user('StrTieB'); c uuid := tests.make_user('StrTieC');
  e uuid := tests.make_user('StrTieE'); T bigint := extract(epoch from now())::bigint; P bigint := T + 30 * 86400; begin
  -- created incomplete et updated active d'un même Checkout, même seconde, reçus à l'envers.
  assert pg_temp.ap(pg_temp.ev('evt_bench_t1u', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t1', a, 'active', P)))
    = 'applied', 't1 updated';
  assert pg_temp.ap(pg_temp.ev('evt_bench_t1c', 'customer.subscription.created', T, pg_temp.sub('sub_bench_t1', a, 'incomplete', P)))
    = 'stale', 't1 created';
  assert (select status from wm.subscriptions where id = 'sub_bench_t1') = 'active' and pg_temp.pro(a), 't1 active';
  -- deleted puis updated active à la même seconde : reste canceled.
  assert pg_temp.ap(pg_temp.ev('evt_bench_t2c', 'customer.subscription.created', T - 100, pg_temp.sub('sub_bench_t2', b, 'active', P)))
    = 'applied', 't2 created';
  assert pg_temp.ap(pg_temp.ev('evt_bench_t2d', 'customer.subscription.deleted', T, pg_temp.sub('sub_bench_t2', b, 'canceled', P)))
    = 'applied', 't2 deleted';
  assert pg_temp.ap(pg_temp.ev('evt_bench_t2u', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t2', b, 'active', P)))
    = 'stale', 't2 updated';
  assert (select status from wm.subscriptions where id = 'sub_bench_t2') = 'canceled' and not pg_temp.pro(b), 't2 canceled';
  -- incomplete_expired puis active à la même seconde : reste incomplete_expired.
  assert pg_temp.ap(pg_temp.ev('evt_bench_t3x', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t3', c, 'incomplete_expired', P)))
    = 'applied', 't3 expired';
  assert pg_temp.ap(pg_temp.ev('evt_bench_t3a', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t3', c, 'active', P)))
    = 'stale', 't3 active';
  assert (select status from wm.subscriptions where id = 'sub_bench_t3') = 'incomplete_expired' and not pg_temp.pro(c), 't3';
  -- active, active puis past_due à la même seconde : chacun réappliqué, past_due final.
  assert pg_temp.ap(pg_temp.ev('evt_bench_t4a', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t4', e, 'active', P)))
    = 'applied', 't4 a';
  assert pg_temp.ap(pg_temp.ev('evt_bench_t4b', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t4', e, 'active', P)))
    = 'applied', 't4 b';
  assert pg_temp.ap(pg_temp.ev('evt_bench_t4p', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t4', e, 'past_due', P)))
    = 'applied', 't4 past_due';
  assert (select status from wm.subscriptions where id = 'sub_bench_t4') = 'past_due' and not pg_temp.pro(e), 't4';
  -- incomplete sur incomplete à la même seconde : réappliqué.
  assert pg_temp.ap(pg_temp.ev('evt_bench_t5a', 'customer.subscription.created', T, pg_temp.sub('sub_bench_t5', e, 'incomplete', P)))
    = 'applied', 't5 a';
  assert pg_temp.ap(pg_temp.ev('evt_bench_t5b', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_t5', e, 'incomplete', P, true)))
    = 'applied', 't5 b';
  perform pg_temp.inv('départage');
end $$;

-- Objet incomplet (G29) : amount_total et currency nuls → achat à 0 et '', crédit unique, aucune exception.
do $$ declare a uuid := tests.make_user('StrApI'); T bigint := extract(epoch from now())::bigint;
  o jsonb := pg_temp.cs('cs_test_bench_inc', a, 'payment') || '{"amount_total": null, "currency": null}'; begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_i1', 'checkout.session.completed', T, o)) = 'applied', 'incomplet';
  assert pg_temp.ap(pg_temp.ev('evt_bench_i2', 'checkout.session.async_payment_succeeded', T, o)) = 'applied', 'incomplet, async';
  assert (select jsonb_agg(jsonb_build_object('amount', amount, 'currency', currency, 'wb', wb)) from wm.purchases where user_id = a)
    = '[{"amount": 0, "currency": "", "wb": 2500}]', 'achat';
  assert pg_temp.bal(a) = 2500 and (select count(*) from wm.wb_ledger where user_id = a and reason = 'stripe') = 1, 'crédit unique';
  -- Sans objet ni id de session : ignoré, jamais une exception rejouée.
  assert pg_temp.ap('{"id": "evt_bench_i3", "type": "checkout.session.completed", "created": 1}') = 'ignored', 'sans objet';
  assert pg_temp.ap(pg_temp.ev('evt_bench_i4', 'customer.subscription.updated', T, '{}')) = 'ignored', 'abonnement sans id';
  assert pg_temp.ap(pg_temp.ev('evt_bench_i5', 'charge.dispute.created', T, '{}')) = 'ignored', 'litige sans id';
  -- Statut d'abonnement nul ou hors des huit valeurs : ignoré, aucune ligne.
  assert pg_temp.ap(pg_temp.ev('evt_bench_i6', 'customer.subscription.created', T, pg_temp.sub('sub_bench_i6', a, null, T)))
    = 'ignored', 'statut nul';
  assert pg_temp.ap(pg_temp.ev('evt_bench_i7', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_i6', a, 'bogus', T)))
    = 'ignored', 'statut inconnu';
  assert not exists (select from wm.subscriptions where id = 'sub_bench_i6'), 'aucune ligne';
  perform pg_temp.inv('objet incomplet');
end $$;

-- Résolution du joueur (stripe_uid, G29) : uuid en forme et existant, dans l'ordre, sinon le Customer relié ; jamais d'exception de cast.
do $$ declare a uuid := tests.make_user('StrUidA'); b uuid := tests.make_user('StrUidB'); T bigint := extract(epoch from now())::bigint;
  P bigint := T + 30 * 86400; x uuid := gen_random_uuid(); o jsonb; begin
  assert wm.stripe_uid(array['abc', null, x::text, a::text, b::text], null) = a, 'premier existant';
  assert wm.stripe_uid(array[upper(a::text)], null) is null, 'majuscules';
  assert wm.stripe_uid(array[]::text[], null) is null and wm.stripe_uid(null, null) is null, 'vide';
  insert into wm.stripe_customers (customer_id, user_id) values (pg_temp.cus(b), b);
  assert wm.stripe_uid(array['abc'], pg_temp.cus(b)) = b and wm.stripe_uid(array[a::text], pg_temp.cus(b)) = a, 'Customer en dernier';
  o := jsonb_set(pg_temp.sub('sub_bench_r1', x, 'active', P), '{metadata,uid}', '"abc"');
  assert pg_temp.ap(pg_temp.ev('evt_bench_r1', 'customer.subscription.created', T, o)) = 'unresolved', 'abc';
  assert pg_temp.ap(pg_temp.ev('evt_bench_r2', 'customer.subscription.created', T, pg_temp.sub('sub_bench_r2', x, 'active', P)))
    = 'unresolved', 'uuid inexistant';
  assert (select outcome from wm.stripe_events where id = 'evt_bench_r2') = 'unresolved', 'unresolved stocké';
  assert not exists (select from wm.subscriptions where id in ('sub_bench_r1', 'sub_bench_r2')), 'rien écrit';
  assert pg_temp.ap(pg_temp.ev('evt_bench_r3', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_r3', x, 'payment')))
    = 'unresolved', 'Checkout introuvable';
  assert not exists (select from wm.purchases where session_id = 'cs_test_bench_r3'), 'aucun achat';
  -- client_reference_id illisible : metadata.uid prend le relais.
  o := jsonb_set(pg_temp.cs('cs_test_bench_r4', a, 'payment'), '{client_reference_id}', '"abc"');
  assert pg_temp.ap(pg_temp.ev('evt_bench_r4', 'checkout.session.completed', T, o)) = 'applied' and pg_temp.bal(a) = 2500, 'metadata.uid';
  -- Abonnement résolu par le seul Customer relié.
  o := jsonb_set(pg_temp.sub('sub_bench_r5', b, 'active', P), '{metadata}', '{}');
  assert pg_temp.ap(pg_temp.ev('evt_bench_r5', 'customer.subscription.created', T, o)) = 'applied' and pg_temp.pro(b), 'par Customer';
  -- Une ligne connue garde son joueur, même si metadata.uid change.
  o := pg_temp.sub('sub_bench_r5', a, 'canceled', P);
  assert pg_temp.ap(pg_temp.ev('evt_bench_r6', 'customer.subscription.deleted', T + 1, o)) = 'applied', 'uid retouché';
  assert (select user_id from wm.subscriptions where id = 'sub_bench_r5') = b and not pg_temp.pro(b), 'joueur gardé';
  perform pg_temp.inv('résolution');
end $$;

-- Factures (G29, C5) : latest_invoice_* de l'abonnement s'il existe et si plus récent ; échec → pro_payment_failed.
do $$ declare a uuid := tests.make_user('StrInv'); b uuid := tests.make_user('StrInvB'); T bigint := extract(epoch from now())::bigint; P bigint := T + 30 * 86400; i jsonb;
  begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_f0', 'customer.subscription.created', T, pg_temp.sub('sub_bench_1', a, 'active', P))) = 'applied';
  i := jsonb_build_object('id', 'in_bench_1', 'object', 'invoice', 'customer', pg_temp.cus(a), 'created', T, 'parent',
    jsonb_build_object('subscription_details', jsonb_build_object('subscription', 'sub_bench_1', 'metadata', jsonb_build_object('uid', a))));
  assert pg_temp.ap(pg_temp.ev('evt_bench_f1', 'invoice.payment_failed', T + 5, i)) = 'applied', 'échec';
  assert (select latest_invoice_status = 'payment_failed' and latest_invoice_at = to_timestamp(T) and status = 'active'
    from wm.subscriptions where id = 'sub_bench_1'), 'payment_failed';
  assert (select jsonb_agg(data) from public.notifications where user_id = a and type = 'pro_payment_failed')
    = '[{"subscription_id": "sub_bench_1", "invoice_id": "in_bench_1"}]', 'pro_payment_failed';
  assert pg_temp.pro(a), 'Pro inchangé par une facture';
  assert pg_temp.ap(pg_temp.ev('evt_bench_f2', 'invoice.paid', T + 105, i || jsonb_build_object('id', 'in_bench_2', 'created', T + 100)))
    = 'applied', 'payée';
  assert (select latest_invoice_status = 'paid' and latest_invoice_at = to_timestamp(T + 100) from wm.subscriptions where id = 'sub_bench_1'),
    'paid';
  -- Un échec plus ancien, reçu après : ni écrit ni notifié.
  assert pg_temp.ap(pg_temp.ev('evt_bench_f3', 'invoice.payment_failed', T + 106, i || jsonb_build_object('id', 'in_bench_0', 'created', T - 100)))
    = 'applied', 'échec ancien';
  assert (select latest_invoice_status from wm.subscriptions where id = 'sub_bench_1') = 'paid' and pg_temp.n(a, 'pro_payment_failed') = 1,
    'échec ancien ignoré';
  -- Abonnement inconnu : appliqué, rien écrit.
  assert pg_temp.ap(pg_temp.ev('evt_bench_f4', 'invoice.payment_failed', T + 107, jsonb_set(i, '{parent,subscription_details,subscription}',
    '"sub_bench_inconnu"'))) = 'applied', 'abonnement inconnu';
  assert pg_temp.n(a, 'pro_payment_failed') = 1 and not exists (select from wm.subscriptions where id = 'sub_bench_inconnu'), 'rien écrit';
  -- Même facture, même created : un échec reçu après paid ne le remplace pas et ne notifie pas.
  assert pg_temp.ap(pg_temp.ev('evt_bench_f6', 'invoice.payment_failed', T + 109, i || jsonb_build_object('id', 'in_bench_2', 'created', T + 100)))
    = 'applied', 'échec à égalité';
  assert (select latest_invoice_status = 'paid' and latest_invoice_at = to_timestamp(T + 100) from wm.subscriptions where id = 'sub_bench_1')
    and pg_temp.n(a, 'pro_payment_failed') = 1, 'paid gardé à égalité';
  -- metadata.uid d'un autre joueur : la ligne et la notification restent au propriétaire de l'abonnement.
  assert pg_temp.ap(pg_temp.ev('evt_bench_f7', 'invoice.payment_failed', T + 205, jsonb_set(i, '{parent,subscription_details,metadata,uid}',
    to_jsonb(b)) || jsonb_build_object('id', 'in_bench_3', 'created', T + 200))) = 'applied', 'uid d''un autre';
  assert (select latest_invoice_status = 'payment_failed' and latest_invoice_at = to_timestamp(T + 200) from wm.subscriptions
    where id = 'sub_bench_1') and pg_temp.n(a, 'pro_payment_failed') = 2 and pg_temp.n(b, 'pro_payment_failed') = 0, 'propriétaire gardé';
  -- Abonnement inconnu, uid inexistant, Customer inconnu : introuvable.
  assert pg_temp.ap(pg_temp.ev('evt_bench_f5', 'invoice.paid', T + 108, jsonb_set(jsonb_set(jsonb_set(i,
    '{parent,subscription_details,metadata,uid}', to_jsonb(gen_random_uuid())), '{customer}', '"cus_bench_inconnu"'),
    '{parent,subscription_details,subscription}', '"sub_bench_inconnu"'))) = 'unresolved', 'facture introuvable';
  perform pg_temp.inv('factures');
end $$;

-- Litiges (G8, G29) : upsert gardé par event.created.
do $$ declare T bigint := extract(epoch from now())::bigint; dp jsonb := jsonb_build_object('id', 'dp_bench_1', 'object', 'dispute',
  'charge', 'ch_bench_1', 'amount', 499, 'currency', 'cad', 'reason', 'fraudulent', 'status', 'needs_response', 'created', T - 3600); begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_d1', 'charge.dispute.created', T, dp)) = 'applied', 'created';
  assert (select to_jsonb(d) - 'updated_at' from wm.stripe_disputes d where id = 'dp_bench_1') = jsonb_build_object('id', 'dp_bench_1',
    'charge_id', 'ch_bench_1', 'amount', 499, 'currency', 'cad', 'reason', 'fraudulent', 'status', 'needs_response',
    'created_at', to_timestamp(T - 3600), 'event_created', to_timestamp(T)), 'ligne';
  assert pg_temp.ap(pg_temp.ev('evt_bench_d2', 'charge.dispute.closed', T + 50, dp || '{"status": "lost"}')) = 'applied', 'closed';
  assert (select status = 'lost' and event_created = to_timestamp(T + 50) from wm.stripe_disputes where id = 'dp_bench_1'), 'lost';
  assert pg_temp.ap(pg_temp.ev('evt_bench_d3', 'charge.dispute.created', T + 10, dp)) = 'applied', 'created ancien';
  assert (select status = 'lost' and event_created = to_timestamp(T + 50) from wm.stripe_disputes where id = 'dp_bench_1'), 'garde';
  assert (select count(*) from wm.stripe_disputes where id = 'dp_bench_1') = 1, 'une ligne';
  perform pg_temp.inv('litiges');
end $$;

-- Ignorés (G29, D:104) : type inconnu consigné ; livemode vrai sans effet.
do $$ declare a uuid := tests.make_user('StrIgn'); T bigint := extract(epoch from now())::bigint; begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_g1', 'customer.created', T, '{"id": "cus_bench_g1", "object": "customer"}')) = 'ignored', 'inconnu';
  assert (select to_jsonb(s) - 'received_at' from wm.stripe_events s where id = 'evt_bench_g1') = jsonb_build_object('id', 'evt_bench_g1',
    'type', 'customer.created', 'created', to_timestamp(T), 'livemode', false, 'outcome', 'ignored'), 'consigné';
  assert pg_temp.ap(pg_temp.ev('evt_bench_g2', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_live', a, 'payment'))
    || '{"livemode": true}') = 'ignored', 'livemode';
  assert (select livemode from wm.stripe_events where id = 'evt_bench_g2'), 'livemode stocké';
  assert pg_temp.bal(a) = 0 and not exists (select from wm.purchases where user_id = a)
    and not exists (select from wm.stripe_customers where user_id = a), 'livemode sans effet';
  perform pg_temp.inv('ignorés');
end $$;

-- Refus : événement invalide (400) ; maintenance (503) sans ligne stripe_events, le rejeu ensuite passe.
do $$ declare a uuid := tests.make_user('StrRef'); T bigint := extract(epoch from now())::bigint; e jsonb;
  bad jsonb := '{"status":400,"code":"invalid_request","error":"Événement invalide","message":"Événement invalide"}'; begin
  assert pg_temp.err('select wm.stripe_apply(''{}'')') = bad, '{}';
  assert pg_temp.err('select wm.stripe_apply(null)') = bad, 'null';
  assert pg_temp.err('select wm.stripe_apply(''{"type": "x", "created": 1}'')') = bad, 'sans id';
  assert pg_temp.err('select wm.stripe_apply(''{"id": "evt_bench_v1", "created": 1}'')') = bad, 'sans type';
  assert pg_temp.err('select wm.stripe_apply(''{"id": "evt_bench_v1", "type": "x"}'')') = bad, 'sans created';
  assert pg_temp.err('select wm.stripe_apply(''{"id": "evt_bench_v1", "type": "x", "created": "abc"}'')') = bad, 'created illisible';
  assert pg_temp.err('select wm.stripe_apply(''{"id": "xx_bench_v1", "type": "x", "created": 1}'')') = bad, 'id hors evt_';
  assert not exists (select from wm.stripe_events where id = 'evt_bench_v1'), 'aucune ligne';
  e := pg_temp.ev('evt_bench_mt', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_mt', a, 'payment'));
  update wm.config set value = 'true' where key = 'maintenance';
  assert pg_temp.err(format('select wm.stripe_apply(%L)', e)) = '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.","message":"Maintenance en cours, reviens dans quelques minutes."}', 'maintenance';
  update wm.config set value = 'false' where key = 'maintenance';
  assert not exists (select from wm.stripe_events where id = 'evt_bench_mt') and pg_temp.bal(a) = 0, 'rien en maintenance';
  assert pg_temp.ap(e) = 'applied' and pg_temp.bal(a) = 2500, 'rejeu après la maintenance';
  perform pg_temp.inv('refus');
end $$;

-- Pierre tombale (G35, G38) : état d'abonnement, crédit inerte, stripe_pending recalculé, aucune notification.
do $$ declare a uuid := tests.make_user('StrTomb'); T bigint := extract(epoch from now())::bigint; P bigint := T + 30 * 86400; begin
  insert into wm.deleted_accounts (user_id) values (a);
  assert not (select stripe_pending from wm.deleted_accounts where user_id = a), 'avant';
  assert pg_temp.ap(pg_temp.ev('evt_bench_x1', 'customer.subscription.created', T, pg_temp.sub('sub_bench_x1', a, 'active', P)))
    = 'applied', 'created';
  assert (select stripe_pending from wm.deleted_accounts where user_id = a) and pg_temp.pro(a), 'stripe_pending posé';
  assert pg_temp.ap(pg_temp.ev('evt_bench_x2', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_x2', a, 'payment')))
    = 'applied' and pg_temp.bal(a) = 2500, 'crédit inerte';
  assert pg_temp.ap(pg_temp.ev('evt_bench_x3', 'customer.subscription.deleted', T + 10, pg_temp.sub('sub_bench_x1', a, 'canceled', P)))
    = 'applied', 'deleted';
  assert not (select stripe_pending from wm.deleted_accounts where user_id = a) and not pg_temp.pro(a), 'stripe_pending levé';
  assert not exists (select from public.notifications where user_id = a), 'aucune notification';
  perform pg_temp.inv('pierre tombale');
end $$;

-- Erreur injectée (D:628) : l'effet échoue → aucune ligne stripe_events ni de grand livre (même transaction) ; Stripe réessaie et passe.
do $$ declare a uuid := tests.make_user('StrBoom'); T bigint := extract(epoch from now())::bigint; e jsonb; raised boolean := false; begin
  e := pg_temp.ev('evt_bench_b1', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_b1', a, 'payment'));
  create trigger zz_boom after insert on wm.purchases for each row when (new.session_id = 'cs_test_bench_b1') execute function tests.boom();
  begin
    perform wm.stripe_apply(e);
  exception when sqlstate 'XX000' then
    raised := true;
  end;
  drop trigger zz_boom on wm.purchases;
  assert raised, 'erreur avalée';
  assert not exists (select from wm.stripe_events where id = 'evt_bench_b1') and not exists (select from wm.wb_ledger where user_id = a)
    and not exists (select from wm.purchases where user_id = a) and pg_temp.bal(a) = 0, 'effet partiel';
  assert pg_temp.ap(e) = 'applied' and pg_temp.bal(a) = 2500, 'relance';
  perform pg_temp.inv('erreur injectée');
end $$;

-- lock_timeout avant la première écriture (P5) ; stripe_apply : la ligne stripe_events est le premier verrou, avant le profil (C4).
do $$ declare bad text := tests.lock_timeout_violations(array['stripe_customer_set'], array['insert into wm.stripe_customers']);
  s text := (select prosrc from pg_proc where oid = to_regproc('wm.stripe_apply')); begin
  assert bad is null, 'lock_timeout absent ou tardif : ' || bad;
  bad := tests.lock_timeout_violations(array['stripe_apply'], array['insert into wm.stripe_events', 'wm.lock_user(']);
  assert bad is null, 'lock_timeout absent ou tardif : ' || bad;
  assert strpos(s, 'insert into wm.stripe_events') between 1 and strpos(s, 'wm.lock_user(') - 1, 'stripe_events après le profil';
end $$;

-- ===== 2320 : invariants, export, tableau de bord, résiliation =====

-- stripe_purchase (G25 a) : ligne stripe sans achat, achat sans ligne, montant différent ; chaque violation dans une sous-transaction
-- annulée (WMT00), la liste entière comparée (les invariants sont vides avant).
do $$ declare a uuid := tests.make_user('StrInvP'); d jsonb; begin
  begin
    perform wm.wallet_apply(a, 2500, 'stripe', 'stripe:cs_test_bench_x');
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d = jsonb_build_array(jsonb_build_object('check', 'stripe_purchase', 'ref', 'stripe:cs_test_bench_x', 'user_id', a,
    'problem', 'no_purchase')), coalesce(d::text, 'aucune');
  begin
    insert into wm.purchases (session_id, user_id, item, amount, currency, wb) values ('cs_test_bench_nl', a, 'wb_2500', 499, 'cad', 2500);
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d = jsonb_build_array(jsonb_build_object('check', 'stripe_purchase', 'session_id', 'cs_test_bench_nl', 'user_id', a,
    'problem', 'no_ledger')), coalesce(d::text, 'aucune');
  begin
    insert into wm.purchases (session_id, user_id, item, amount, currency, wb) values ('cs_test_bench_am', a, 'wb_2500', 499, 'cad', 100);
    perform wm.wallet_apply(a, 2500, 'stripe', 'stripe:cs_test_bench_am');
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d = jsonb_build_array(jsonb_build_object('check', 'stripe_purchase', 'ref', 'stripe:cs_test_bench_am', 'user_id', a,
    'problem', 'amount')), coalesce(d::text, 'aucune');
  -- Une ligne stripe face à un achat pro_monthly de la même session n'est pas couverte.
  begin
    insert into wm.purchases (session_id, user_id, item, amount, currency, wb) values ('cs_test_bench_pm', a, 'pro_monthly', 999, 'cad', 0);
    perform wm.wallet_apply(a, 2500, 'stripe', 'stripe:cs_test_bench_pm');
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d = jsonb_build_array(jsonb_build_object('check', 'stripe_purchase', 'ref', 'stripe:cs_test_bench_pm', 'user_id', a,
    'problem', 'no_purchase')), coalesce(d::text, 'aucune');
  perform pg_temp.inv('stripe_purchase');
end $$;

-- stripe_pro (G25 b) : abonnement active posé à la main sur un profil non Pro → une violation ; stripe_apply la répare.
do $$ declare a uuid := tests.make_user('StrInvPro'); T bigint := extract(epoch from now())::bigint; P bigint := T + 30 * 86400; begin
  perform pg_temp.sub('sub_bench_invpro', a, 'active', now() - interval '1 day');
  assert wm.check_invariants() = jsonb_build_array(jsonb_build_object('check', 'stripe_pro', 'subscription_id', 'sub_bench_invpro',
    'user_id', a)), wm.check_invariants()::text;
  assert pg_temp.ap(pg_temp.ev('evt_bench_invpro', 'customer.subscription.updated', T, pg_temp.sub('sub_bench_invpro', a, 'active', P)))
    = 'applied' and pg_temp.pro(a), 'stripe_apply';
  perform pg_temp.inv('stripe_pro');
  -- trialing compte aussi ; past_due non.
  update public.profiles set is_pro = false where id = a;
  update wm.subscriptions set status = 'trialing' where id = 'sub_bench_invpro';
  assert wm.check_invariants() = jsonb_build_array(jsonb_build_object('check', 'stripe_pro', 'subscription_id', 'sub_bench_invpro',
    'user_id', a)), 'trialing';
  update wm.subscriptions set status = 'past_due' where id = 'sub_bench_invpro';
  perform pg_temp.inv('past_due');
end $$;

-- Export (G24) : Customer, abonnement, deux achats aux valeurs exactes ; aucun price_id ; joueur sans paiement.
do $$ declare a uuid := tests.make_user('StrExp'); b uuid := tests.make_user('StrExpB'); T bigint := extract(epoch from now())::bigint;
  P bigint := T + 30 * 86400; x jsonb; begin
  assert pg_temp.ap(pg_temp.ev('evt_bench_e1', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_e1', a, 'payment'))) = 'applied';
  assert pg_temp.ap(pg_temp.ev('evt_bench_e2', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_e2', a, 'subscription')))
    = 'applied';
  assert pg_temp.ap(pg_temp.ev('evt_bench_e3', 'customer.subscription.created', T, pg_temp.sub('sub_bench_e3', a, 'active', P, true)))
    = 'applied';
  x := wm.account_export(a);
  assert x -> 'stripe_customer_id' = to_jsonb(pg_temp.cus(a)), 'stripe_customer_id';
  assert x -> 'subscriptions' = jsonb_build_array(jsonb_build_object('id', 'sub_bench_e3', 'status', 'active',
    'current_period_end', to_timestamp(P), 'cancel_at_period_end', true, 'cancel_at', to_timestamp(P), 'canceled_at', null,
    'latest_invoice_status', null, 'updated_at', now())), x -> 'subscriptions';
  assert x -> 'purchases' = jsonb_build_array(
    jsonb_build_object('session_id', 'cs_test_bench_e1', 'item', 'wb_2500', 'amount', 499, 'currency', 'cad', 'consent', 'accepted',
      'wb', 2500, 'created_at', now()),
    jsonb_build_object('session_id', 'cs_test_bench_e2', 'item', 'pro_monthly', 'amount', 999, 'currency', 'cad', 'consent', 'accepted',
      'wb', 0, 'created_at', now())), x -> 'purchases';
  assert strpos(x::text, 'price_test_bench') = 0, 'price_id exporté';
  x := wm.account_export(b);
  assert x -> 'stripe_customer_id' = 'null' and x -> 'subscriptions' = '[]' and x -> 'purchases' = '[]', 'sans paiement';
  perform pg_temp.inv('export');
end $$;

-- Tableau de bord (G8, G10, G38) : écarts sur un jeu construit (compteurs globaux) ; litige ouvert et fermé, pierre tombale stripe_pending,
-- achat après la suppression (compté, listé) et avant (ni l'un ni l'autre). Ordres et plafonds prouvés par des lignes hors d'atteinte des
-- autres blocs : created_at dans le futur (litiges, achats), deleted_at un siècle avant (pierres tombales).
do $$ declare st uuid := tests.make_user('StrDashM'); dl uuid := tests.make_user('StrDashD'); d0 uuid := tests.make_user('StrDashD0');
  dm uuid := tests.make_user('StrDashDM'); T bigint := extract(epoch from now())::bigint;
  dp jsonb := jsonb_build_object('id', 'dp_bench_open', 'object', 'dispute', 'charge', 'ch_bench_open', 'amount', 499, 'currency', 'cad',
    'reason', 'fraudulent', 'status', 'needs_response', 'created', T - 3600);
  adm jsonb := (select value from wm.config where key = 'admin'); r0 jsonb; r jsonb; begin
  insert into wm.staff (user_id, role) values (st, 'moderator');
  r0 := wm.staff_dashboard(st);
  assert pg_temp.ap(pg_temp.ev('evt_bench_dd1', 'charge.dispute.created', T, dp)) = 'applied', 'ouvert';
  assert pg_temp.ap(pg_temp.ev('evt_bench_dd2', 'charge.dispute.closed', T, dp || '{"id": "dp_bench_closed", "status": "won"}'))
    = 'applied', 'fermé';
  update public.profiles set is_pro = true where id = dl;
  perform pg_temp.sub('sub_bench_dash', dl, 'active');
  insert into wm.purchases (session_id, user_id, item, amount, currency, wb, created_at)
  values ('cs_test_bench_dash_old', dl, 'pro_monthly', 999, 'cad', 0, now() - interval '1 day');
  insert into wm.deleted_accounts (user_id) values (dl);
  assert pg_temp.ap(pg_temp.ev('evt_bench_dd3', 'checkout.session.completed', T, pg_temp.cs('cs_test_bench_dash', dl, 'payment')))
    = 'applied', 'achat sur pierre tombale';
  r := wm.staff_dashboard(st);
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['active_sanctions', 'auth_pending', 'auto_hidden_cards',
    'health', 'image_reports', 'open_reports', 'purchases_on_deleted', 'purchases_on_deleted_list', 'removed_cards', 'stripe_disputes',
    'stripe_disputes_open', 'stripe_pending', 'stripe_pending_users'], 'clés';
  assert jsonb_build_object('stripe_disputes_open', (r ->> 'stripe_disputes_open')::int - (r0 ->> 'stripe_disputes_open')::int,
    'stripe_pending', (r ->> 'stripe_pending')::int - (r0 ->> 'stripe_pending')::int,
    'purchases_on_deleted', (r ->> 'purchases_on_deleted')::int - (r0 ->> 'purchases_on_deleted')::int)
    = '{"stripe_disputes_open": 1, "stripe_pending": 1, "purchases_on_deleted": 1}', r::text;
  assert r -> 'stripe_disputes' @> jsonb_build_array(jsonb_build_object('id', 'dp_bench_open', 'amount', 499, 'currency', 'cad',
    'reason', 'fraudulent', 'status', 'needs_response', 'created_at', to_timestamp(T - 3600))), 'litige ouvert listé';
  assert (select count(*) from jsonb_array_elements(r -> 'stripe_disputes') e where e ->> 'id' = 'dp_bench_open') = 1
    and not exists (select from jsonb_array_elements(r -> 'stripe_disputes') e where e ->> 'id' = 'dp_bench_closed'), 'litige fermé listé';
  assert r -> 'stripe_pending_users' @> jsonb_build_array(jsonb_build_object('user_id', dl,
    'username', (select username from public.profiles where id = dl), 'deleted_at', now())), 'pierre tombale listée';
  assert r -> 'purchases_on_deleted_list' @> jsonb_build_array(jsonb_build_object('session_id', 'cs_test_bench_dash', 'user_id', dl,
    'item', 'wb_2500', 'amount', 499, 'currency', 'cad', 'created_at', now())), 'achat sur pierre tombale listé';
  assert (select count(*) from jsonb_array_elements(r -> 'purchases_on_deleted_list') e where e ->> 'session_id' = 'cs_test_bench_dash') = 1
    and not exists (select from jsonb_array_elements(r -> 'purchases_on_deleted_list') e where e ->> 'session_id' = 'cs_test_bench_dash_old'),
    'achat d''avant la suppression listé';
  -- 21 litiges ouverts dans le futur : les 20 plus récents, du plus récent au plus ancien.
  insert into wm.stripe_disputes (id, amount, currency, status, created_at, event_created)
  select 'dp_bench_many_' || lpad(i::text, 2, '0'), 1, 'cad', 'needs_response', now() + make_interval(secs => i), now()
  from generate_series(1, 21) i;
  assert (select array_agg(e ->> 'id') from jsonb_array_elements(wm.staff_dashboard(st) -> 'stripe_disputes') e)
    = (select array_agg('dp_bench_many_' || lpad(i::text, 2, '0') order by i desc) from generate_series(2, 21) i), 'les 20 litiges les plus récents';
  -- 21 achats dans le futur sur une pierre tombale (pro_monthly, wb 0 : aucune ligne de grand livre attendue) : les 20 plus récents.
  insert into wm.deleted_accounts (user_id) values (dm);
  insert into wm.purchases (session_id, user_id, item, amount, currency, wb, created_at)
  select 'cs_test_bench_many_' || lpad(i::text, 2, '0'), dm, 'pro_monthly', 999, 'cad', 0, now() + make_interval(secs => i)
  from generate_series(1, 21) i;
  r := wm.staff_dashboard(st);
  assert (r ->> 'purchases_on_deleted')::int - (r0 ->> 'purchases_on_deleted')::int = 22, 'compte non plafonné';
  assert (select array_agg(e ->> 'session_id') from jsonb_array_elements(r -> 'purchases_on_deleted_list') e)
    = (select array_agg('cs_test_bench_many_' || lpad(i::text, 2, '0') order by i desc) from generate_series(2, 21) i), 'les 20 achats les plus récents';
  assert r -> 'purchases_on_deleted_list' -> 0 = jsonb_build_object('session_id', 'cs_test_bench_many_21', 'user_id', dm, 'item', 'pro_monthly',
    'amount', 999, 'currency', 'cad', 'created_at', now() + interval '21 seconds'), 'forme d''un achat listé';
  -- Résiliations en attente : la plus ancienne d'abord ; admin.page plafonne la liste, pas le compte.
  update public.profiles set is_pro = true where id = d0;
  perform pg_temp.sub('sub_bench_dash_0', d0, 'active');
  insert into wm.deleted_accounts (user_id, deleted_at) values (d0, now() - interval '100 years');
  r := wm.staff_dashboard(st);
  assert r -> 'stripe_pending_users' -> 0 = jsonb_build_object('user_id', d0, 'username', (select username from public.profiles where id = d0),
    'deleted_at', now() - interval '100 years'), 'la plus ancienne d''abord';
  assert (select bool_and((a ->> 'deleted_at')::timestamptz <= (b ->> 'deleted_at')::timestamptz) from jsonb_array_elements(r -> 'stripe_pending_users')
    with ordinality x (a, i) join jsonb_array_elements(r -> 'stripe_pending_users') with ordinality y (b, j) on j = i + 1), 'ordre';
  update wm.config set value = value || '{"page": 1}' where key = 'admin';
  r := wm.staff_dashboard(st);
  assert r -> 'stripe_pending_users' = jsonb_build_array(jsonb_build_object('user_id', d0, 'username',
    (select username from public.profiles where id = d0), 'deleted_at', now() - interval '100 years')), 'plafond admin.page';
  assert (r ->> 'stripe_pending')::int - (r0 ->> 'stripe_pending')::int = 2, 'compte non plafonné';
  update wm.config set value = adm where key = 'admin';
  perform pg_temp.inv('tableau de bord');
end $$;

-- Résiliation (G10, G35) : cibles non terminales ; admin_stripe_cancel (chemin staff du M6a, P6a:35) ; stripe_cancel_done.
do $$ declare ad uuid := tests.make_user('StrCanA'); mo uuid := tests.make_user('StrCanM'); d uuid := tests.make_user('StrCanD');
  d2 uuid := tests.make_user('StrCanD2'); c uuid := tests.make_user('StrCanC'); n uuid := tests.make_user('StrCanN');
  q text := 'select wm.admin_stripe_cancel(%L, %L, %L)'; r jsonb; e jsonb;
  none jsonb := '{"status":409,"error":"Aucune résiliation en attente","message":"Aucune résiliation en attente"}'; begin
  insert into wm.staff (user_id, role) values (ad, 'admin'), (mo, 'moderator');
  update public.profiles set is_pro = true where id in (d, d2);
  perform pg_temp.sub('sub_bench_cx_1', d, 'active');
  perform pg_temp.sub('sub_bench_cx_0', d, 'canceled');
  perform pg_temp.sub('sub_bench_cx_c', c, 'canceled');
  insert into wm.deleted_accounts (user_id) values (d), (c);
  assert wm.stripe_cancel_targets(d) = '{"subscription_ids": ["sub_bench_cx_1"]}', 'cibles';
  assert wm.stripe_cancel_targets(c) = '{"subscription_ids": []}', 'canceled seul';
  -- Modérateur : 403 sans audit ; motif trop court : 400 ; rien en attente (pas de pierre tombale, ou drapeau faux) : 409.
  e := pg_temp.err(format(q, mo, d, 'Résiliation'));
  assert e = '{"status":403,"code":"FORBIDDEN","error":"Action réservée aux administrateurs","message":"Action réservée aux administrateurs"}',
    coalesce(e::text, 'acceptée');
  e := pg_temp.err(format(q, ad, d, 'ab'));
  assert e = '{"status":400,"code":"invalid_request","error":"Le motif est obligatoire (3 à 500 caractères)","message":"Le motif est obligatoire (3 à 500 caractères)"}',
    coalesce(e::text, 'acceptée');
  assert pg_temp.err(format(q, ad, n, 'Résiliation')) = none, 'sans pierre tombale';
  assert pg_temp.err(format(q, ad, c, 'Résiliation')) = none, 'drapeau faux';
  assert not exists (select from wm.staff_actions where target_id in (d::text, c::text, n::text)), 'audit d''un refus';
  -- Succès, même clé deux fois : même corps, une ligne d'audit.
  r := wm.admin_stripe_cancel(ad, d, '  Résiliation après suppression  ', 'idem-stripe-cancel');
  assert r = jsonb_build_object('stripe', jsonb_build_object('user_id', d, 'subscription_ids', jsonb_build_array('sub_bench_cx_1'))), r::text;
  assert wm.admin_stripe_cancel(ad, d, 'Résiliation après suppression', 'idem-stripe-cancel') = r, 'rejeu par clé';
  assert (select jsonb_agg(jsonb_build_object('staff_id', staff_id, 'action', action, 'target_type', target_type, 'reason', reason,
    'payload', payload)) from wm.staff_actions where target_id = d::text) = jsonb_build_array(jsonb_build_object('staff_id', ad,
    'action', 'stripe_cancel', 'target_type', 'user', 'reason', 'Résiliation après suppression',
    'payload', '{"subscription_ids": ["sub_bench_cx_1"]}'::jsonb)), 'une ligne d''audit';
  assert (select stripe_pending from wm.deleted_accounts where user_id = d), 'admin_stripe_cancel n''écrit pas le drapeau';
  -- Résiliation réussie : drapeau levé.
  assert wm.stripe_cancel_done(d, array['sub_bench_cx_1']) = '{"ok": true, "stripe_pending": false}', 'done';
  assert not (select stripe_pending from wm.deleted_accounts where user_id = d), 'drapeau levé';
  assert pg_temp.err(format(q, ad, d, 'Résiliation')) = none, 'plus rien en attente';
  -- Review Focus, abonné supprimé : un second abonnement créé entre les cibles et la fin garde le drapeau ; ids nuls aussi.
  perform pg_temp.sub('sub_bench_cx_3', d2, 'active');
  insert into wm.deleted_accounts (user_id) values (d2);
  assert wm.stripe_cancel_targets(d2) = '{"subscription_ids": ["sub_bench_cx_3"]}', 'cibles d2';
  perform pg_temp.sub('sub_bench_cx_4', d2, 'active');
  assert wm.stripe_cancel_done(d2, array['sub_bench_cx_3']) = '{"ok": true, "stripe_pending": true}', 'second abonnement';
  assert (select stripe_pending from wm.deleted_accounts where user_id = d2), 'drapeau gardé';
  assert wm.stripe_cancel_done(d2, null) = '{"ok": true, "stripe_pending": true}', 'ids nuls';
  assert wm.stripe_cancel_done(d2, array['sub_bench_cx_3', 'sub_bench_cx_4']) = '{"ok": true, "stripe_pending": false}', 'les deux';
  assert wm.stripe_cancel_done(n, array['sub_bench_cx_3']) = '{"ok": true, "stripe_pending": false}', 'sans pierre tombale';
  assert not exists (select from wm.deleted_accounts where user_id = n), 'aucune pierre tombale créée';
  perform pg_temp.inv('résiliation');
end $$;

-- lock_timeout avant le premier verrou (P5).
do $$ declare bad text := tests.lock_timeout_violations(array['stripe_cancel_done', 'admin_stripe_cancel'],
  array['update wm.deleted_accounts', 'for update']); begin
  assert bad is null, 'lock_timeout absent ou tardif : ' || bad;
end $$;

select pg_temp.inv('fin de 40');
