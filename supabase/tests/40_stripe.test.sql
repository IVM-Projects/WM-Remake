-- Socle Stripe (2300_wm_stripe_core.sql) : config shop, tables, drapeau stripe_pending posé à la suppression, shop_state,
-- stripe_checkout_prepare, stripe_customer_set, stripe_portal_prepare, grace_status, VIP = Pro (S:75) ; les tâches suivantes du M6b
-- ajoutent leurs blocs (stripe_apply…).
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
    'wm.subscriptions'::regclass, 'wm.purchases'::regclass, 'wm.stripe_disputes'::regclass)) = 20, 'contraintes en trop';
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
  assert pg_temp.err(format(q, w, 'wb_2500')) ->> 'code' = 'maintenance', 'maintenance';
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
do $$ declare u uuid := tests.make_user('StrCus'); begin
  assert wm.stripe_customer_set(u, 'cus_bench_a') = 'cus_bench_a', 'premier';
  assert wm.stripe_customer_set(u, 'cus_bench_b') = 'cus_bench_a', 'second';
  assert (select count(*) from wm.stripe_customers where user_id = u) = 1
    and not exists (select from wm.stripe_customers where customer_id = 'cus_bench_b'), 'une seule ligne';
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
  assert pg_temp.err(format(q, d)) ->> 'status' = '401', 'supprimé';
  assert pg_temp.err(format(q, gen_random_uuid())) ->> 'status' = '401', 'profil absent';
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

-- lock_timeout avant la première écriture (P5).
do $$ declare bad text := tests.lock_timeout_violations(array['stripe_customer_set'], array['insert into wm.stripe_customers']); begin
  assert bad is null, 'lock_timeout absent ou tardif : ' || bad;
end $$;

select pg_temp.inv('fin de 40');
