import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type Stripe from 'stripe'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { SHOP } from '../../lib/shop.ts'
import { resetStripeRequests, STRIPE, stripeRequests } from '../harness.ts'
import { benchHex, checkoutCompleted, disputeEvent, event, invoiceEvent, postRaw, sign, signedPost, subscriptionEvent } from '../stripe-events.ts'
import { api, Iso, makeUser, noSession, ok, psql, refused, send } from '../users.ts'

// Boutique, Checkout et Portail contre le faux Stripe de la passerelle (G36) : chaque appel du SDK est journalisé, remis à zéro par cas.
// Joueurs supprimés dans le finally de chaque cas ; tout abonnement actif posé à la main l'est sur un joueur Pro (hygiène des invariants).
const FreePro = z.strictObject({ free: z.int(), pro: z.int() })
const ShopState = z.strictObject({
  rules: z.strictObject({
    pack_size: z.int(), pack_period_s: FreePro, pro_daily_size: z.int(), max_concurrent_auctions: FreePro, battle_quota: FreePro,
    sales_detail_days: z.int(), wb_2500: z.int(),
  }),
  me: z.strictObject({
    balance: z.int(), is_pro: z.boolean(), is_vip: z.boolean(), pack_cap: z.int(), has_customer: z.boolean(),
    subscription: z.strictObject({ status: z.string(), current_period_end: Iso.nullable(), cancel_at_period_end: z.boolean(), cancel_at: Iso.nullable() })
      .nullable(),
  }),
  purchase: z.strictObject({ item: z.enum(['pro_monthly', 'wb_2500']), created_at: Iso }).nullable(),
  maintenance: z.boolean(),
})
const UrlReply = z.strictObject({ url: z.url() })
const Grace = z.strictObject({ available: z.int(), size: z.int().nullable() })
const Cards = z.object({ cards: z.array(z.object({ id: z.uuid() })) })

const MAINTENANCE = 'Maintenance en cours, reviens dans quelques minutes.'
const BLOCKED = 'Ton compte est temporairement restreint.'
const API_VERSION = '2026-10-28.endive'
const hex = () => randomUUID().replaceAll('-', '')

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const checkout = (env: ContractEnv, uid: string | undefined, item: string, key = randomUUID(), extra: Record<string, unknown> = {}) =>
  send(env, 'POST', '/api/stripe/checkout', uid, { item, ...extra }, { 'Idempotency-Key': key })
const portal = (env: ContractEnv, uid: string) => send(env, 'POST', '/api/stripe/portal', uid)
const customerOf = (env: ContractEnv, uid: string) => sql(env, `select customer_id from wm.stripe_customers where user_id = :'u'`, { u: uid })

// Joueurs du cas, supprimés à la fin (pierres tombales comprises) ; les lignes Stripe partent en cascade.
async function withPlayers(env: ContractEnv, run: (player: (opts?: Parameters<typeof makeUser>[1]) => string) => Promise<void>): Promise<void> {
  const ids: string[] = []
  try {
    await run((opts) => {
      const { uid } = makeUser(db(env), opts)
      ids.push(uid)
      return uid
    })
    assert.equal(sql(env, `select wm.check_invariants()`), '[]')
  } finally {
    if (ids.length) {
      sql(env, `select set_config('wm.allow_tombstone_delete', 'on', false);
delete from auth.users where id = any (string_to_array(:'ids', ',')::uuid[])`, { ids: ids.join(',') })
    }
  }
}

async function inMaintenance(env: ContractEnv, run: () => Promise<void>): Promise<void> {
  sql(env, `update wm.config set value = 'true' where key = 'maintenance'`)
  try {
    await run()
  } finally {
    sql(env, `update wm.config set value = 'false' where key = 'maintenance'`)
  }
}

// Sanction posée par psql ; refus au corps entier, échéance relue de la ligne (format jsonb de timestamptz).
function sanction(env: ContractEnv, uid: string, kind: 'restriction' | 'suspension'): string {
  return sql(env, `insert into wm.sanctions (user_id, kind, reason, ends_at) values (:'u', :'k', 'test', now() + interval '1 hour')
returning to_jsonb(ends_at) #>> '{}'`, { u: uid, k: kind })
}
async function blocked(res: Response, until: string): Promise<void> {
  const text = await res.text()
  assert.equal(res.status, 403, text)
  assert.deepEqual(JSON.parse(text), { error: BLOCKED, message: BLOCKED, activity_blocked_until: until })
}

export const shop: RouteSpec = {
  method: 'GET',
  path: '/api/shop',
  source: 'D§7.11',
  confidence: 'ajouté',
  cases: [
    noSession('GET', '/api/shop'),
    {
      name: 'joueur neuf → ShopState strict, maintenance faux, rules.wb_2500 = SHOP.wb_2500.wb (G28), sans Customer ni abonnement ni achat',
      run: (env) => withPlayers(env, async (player) => {
        const state = await ok(await api(env, '/api/shop', { uid: player({ balance: 40 }) }), ShopState)
        assert.equal(state.maintenance, false)
        assert.equal(state.rules.wb_2500, SHOP.wb_2500.wb)
        assert.deepEqual(state.me, { ...state.me, balance: 40, is_pro: false, has_customer: false, subscription: null })
        assert.equal(state.purchase, null)
      }),
    },
    {
      name: '?session=x → 400 invalid_request',
      run: (env) => withPlayers(env, async (player) => {
        await refused(await api(env, '/api/shop?session=x', { uid: player() }), 400, 'Chaîne de caractères invalide : doit correspondre au motif /^cs_(test|live)_[A-Za-z0-9_]{1,200}$/', 'invalid_request')
      }),
    },
    {
      name: 'achat pro_monthly posé par psql → purchase de cette session ; la même session lue par un autre joueur → purchase nul',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const session = `cs_test_bench_${hex()}`
        sql(env, `insert into wm.purchases (session_id, user_id, item, amount, currency, wb) values (:'s', :'u', 'pro_monthly', 999, 'cad', 0)`,
          { s: session, u: uid })
        const state = await ok(await api(env, `/api/shop?session=${session}`, { uid }), ShopState)
        assert.equal(state.purchase?.item, 'pro_monthly')
        assert.equal((await ok(await api(env, `/api/shop?session=${session}`, { uid: player() }), ShopState)).purchase, null)
      }),
    },
    {
      name: 'maintenance (wm.config) → 200, maintenance vrai (G46)',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        await inMaintenance(env, async () => assert.equal((await ok(await api(env, '/api/shop', { uid }), ShopState)).maintenance, true))
      }),
    },
    {
      name: 'joueur suspendu → 403 (access_check)',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const until = sanction(env, uid, 'suspension')
        await blocked(await api(env, '/api/shop', { uid }), until)
      }),
    },
  ],
}

export const stripeCheckout: RouteSpec = {
  method: 'POST',
  path: '/api/stripe/checkout',
  source: 'D§7.11',
  confidence: 'ajouté',
  cases: [
    noSession('POST', '/api/stripe/checkout'),
    {
      name: 'wb_2500 → url de Checkout ; Customer créé une fois (clé G45, metadata.uid, email) puis réutilisé ; paramètres de G17 ; '
        + 'clé d\'idempotence de la session tirée de l\'Idempotency-Key ; price et amount du client ignorés',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        await resetStripeRequests(env)
        const key = randomUUID()
        const { url } = await ok(await checkout(env, uid, 'wb_2500', key), UrlReply)
        assert.match(url, /^https:\/\/checkout\.stripe\.com\//)
        const customer = customerOf(env, uid)
        assert.match(customer, /^cus_bench_[0-9a-f]{32}$/)
        const [created, session, ...rest] = await stripeRequests(env)
        assert.deepEqual(rest, [])
        assert.deepEqual({ ...created, idempotency_key: null }, {
          method: 'POST', path: '/v1/customers', form: { email: `${uid}@test.local`, 'metadata[uid]': uid }, idempotency_key: null,
          stripe_version: API_VERSION,
        })
        assert.match(created.idempotency_key ?? '', new RegExp(`^customer:${uid}:[0-9a-f]{16}$`))
        assert.deepEqual([session.method, session.path, session.stripe_version, session.idempotency_key],
          ['POST', '/v1/checkout/sessions', API_VERSION, `checkout:${uid}:wb_2500:${key}`])
        const f = session.form
        assert.deepEqual({
          mode: f.mode, customer: f.customer, client_reference_id: f.client_reference_id, item: f['metadata[item]'], uid: f['metadata[uid]'],
          price: f['line_items[0][price]'], quantity: f['line_items[0][quantity]'], tos: f['consent_collection[terms_of_service]'], locale: f.locale,
        }, {
          mode: 'payment', customer, client_reference_id: uid, item: 'wb_2500', uid, price: STRIPE.priceWb, quantity: '1', tos: 'required', locale: 'fr',
        })
        assert.match(f['custom_text[terms_of_service_acceptance][message]'], /renonce/)
        assert.match(f.success_url, /\/pulls\?shop=success&session=\{CHECKOUT_SESSION_ID\}$/)
        assert.match(f.cancel_url, /\/pulls\?shop=cancel$/)

        // Second achat, avec un prix et un montant forgés : jamais lus (seul l'article compte).
        await resetStripeRequests(env)
        await ok(await checkout(env, uid, 'wb_2500', randomUUID(), { price: 'price_evil', amount: 1 }), UrlReply)
        const again = await stripeRequests(env)
        assert.deepEqual(again.map((r) => r.path), ['/v1/checkout/sessions'])
        assert.equal(again[0].form['line_items[0][price]'], STRIPE.priceWb)
        assert.ok(!JSON.stringify(again).includes('price_evil'))
        assert.equal(customerOf(env, uid), customer)
      }),
    },
    {
      name: 'pro_monthly → mode subscription, subscription_data.metadata.uid ; abonnement actif (joueur Pro) → 409 already_subscribed sans appel Stripe',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        await resetStripeRequests(env)
        await ok(await checkout(env, uid, 'pro_monthly'), UrlReply)
        const session = (await stripeRequests(env)).find((r) => r.path === '/v1/checkout/sessions')
        assert.equal(session?.form.mode, 'subscription')
        assert.equal(session?.form['subscription_data[metadata][uid]'], uid)
        assert.equal(session?.form['line_items[0][price]'], STRIPE.pricePro)

        sql(env, `update public.profiles set is_pro = true where id = :'u';
insert into wm.subscriptions (id, user_id, customer_id, status, event_created) values (:'s', :'u', :'c', 'active', now())`,
        { u: uid, s: `sub_bench_${hex()}`, c: customerOf(env, uid) })
        await resetStripeRequests(env)
        await refused(await checkout(env, uid, 'pro_monthly'), 409, 'Tu as déjà un abonnement Pro : gère-le depuis les paramètres.', 'already_subscribed')
        assert.deepEqual(await stripeRequests(env), [])
      }),
    },
    {
      name: 'item: "x" → 400 « Article inconnu »',
      run: (env) => withPlayers(env, async (player) => {
        await refused(await checkout(env, player(), 'x'), 400, 'Article inconnu', 'invalid_request')
      }),
    },
    {
      name: 'maintenance → 503 maintenance et Retry-After',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        await inMaintenance(env, async () => {
          const res = await checkout(env, uid, 'wb_2500')
          assert.equal(res.headers.get('retry-after'), '1')
          await refused(res, 503, MAINTENANCE, 'maintenance')
        })
      }),
    },
    {
      name: 'joueur restreint → 403 (wm.actor), sans appel Stripe',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const until = sanction(env, uid, 'restriction')
        await resetStripeRequests(env)
        await blocked(await checkout(env, uid, 'wb_2500'), until)
        assert.deepEqual(await stripeRequests(env), [])
      }),
    },
  ],
}

export const stripePortal: RouteSpec = {
  method: 'POST',
  path: '/api/stripe/portal',
  source: 'D§7.11',
  confidence: 'ajouté',
  cases: [
    noSession('POST', '/api/stripe/portal'),
    {
      name: 'sans Customer → 404 no_customer',
      run: (env) => withPlayers(env, async (player) => {
        await refused(await portal(env, player()), 404, 'Aucun abonnement à gérer', 'no_customer')
      }),
    },
    {
      name: 'avec Customer → url du Portail, return_url /settings ; joueur restreint, puis suspendu → 200 aussi (G39) ; maintenance → 503',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const customer = `cus_bench_${hex()}`
        sql(env, `insert into wm.stripe_customers (customer_id, user_id) values (:'c', :'u')`, { c: customer, u: uid })
        await resetStripeRequests(env)
        assert.match((await ok(await portal(env, uid), UrlReply)).url, /^https:\/\/billing\.stripe\.com\//)
        const [req, ...rest] = await stripeRequests(env)
        assert.deepEqual(rest, [])
        assert.deepEqual([req.method, req.path, req.form.customer, req.stripe_version], ['POST', '/v1/billing_portal/sessions', customer, API_VERSION])
        assert.match(req.form.return_url, /\/settings$/)

        sanction(env, uid, 'restriction')
        await ok(await portal(env, uid), UrlReply)
        // POST : route() ne fait pas access_check, la suspension (refusée aux lectures) laisse aussi résilier.
        sanction(env, uid, 'suspension')
        await ok(await portal(env, uid), UrlReply)
        await inMaintenance(env, async () => refused(await portal(env, uid), 503, MAINTENANCE, 'maintenance'))
      }),
    },
  ],
}

export const graceStatus: RouteSpec = {
  method: 'GET',
  path: '/api/packs/grace',
  source: 'D§7.11',
  confidence: 'ajouté',
  cases: [
    noSession('GET', '/api/packs/grace'),
    {
      name: 'sans dotation → {available: 0, size: null} ; dotation de 5 → {1, 5} ; POST → 5 cartes, puis 0',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player({ humanVerified: true })
        const status = async () => ok(await api(env, '/api/packs/grace', { uid }), Grace)
        assert.deepEqual(await status(), { available: 0, size: null })
        sql(env, `insert into wm.grace_grants (user_id, size, reason) values (:'u', 5, 'contrat')`, { u: uid })
        assert.deepEqual(await status(), { available: 1, size: 5 })
        assert.equal((await ok(await send(env, 'POST', '/api/packs/grace', uid, undefined, { 'Idempotency-Key': randomUUID() }), Cards)).cards.length, 5)
        assert.deepEqual(await status(), { available: 0, size: null })
      }),
    },
    {
      name: 'joueur suspendu → 403 (access_check)',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const until = sanction(env, uid, 'suspension')
        await blocked(await api(env, '/api/packs/grace', { uid }), until)
      }),
    },
  ],
}

// Webhook (G14, G29, G37) : événements signés par le whsec_ factice du banc, postés au corps brut ; ids neufs à chaque cas.
const BUSY = 'Le site est très sollicité, réessaie dans un instant.'
const BAD_SIGNATURE = 'Signature Stripe invalide'
const DAY = 86_400
const LOG_KEYS = ['route', 'status', 'ms', 'rpc', 'pg_code', 'event_type', 'event_id', 'duplicate', 'outcome', 'vercel_id']
const nowS = () => Math.floor(Date.now() / 1000)
const cs = () => `cs_test_bench_${benchHex()}`
const cus = () => `cus_bench_${benchHex()}`
const sub = () => `sub_bench_${benchHex()}`
const hook = (env: ContractEnv, ev: object) => signedPost(env.plain, ev)
const received = async (res: Response) => assert.deepEqual(await ok(res, z.strictObject({ received: z.literal(true) })), { received: true })
const me = async (env: ContractEnv, uid: string) => (await ok(await api(env, '/api/shop', { uid }), ShopState)).me
const balance = async (env: ContractEnv, uid: string) => (await me(env, uid)).balance
const wallet = async (env: ContractEnv, uid: string) =>
  (await ok(await api(env, '/api/wikibidous', { uid }), z.strictObject({ balance: z.int() }))).balance
const notified = async (env: ContractEnv, uid: string) =>
  (await ok(await api(env, '/api/notifications', { uid }), z.object({ notifications: z.array(z.object({ type: z.string() })) })))
    .notifications.map((n) => n.type)
// outcome consigné, ou 'absent' : aucune ligne (signature refusée, maintenance, transaction annulée).
const eventRow = (env: ContractEnv, ev: { id: string }) =>
  sql(env, `select coalesce((select outcome from wm.stripe_events where id = :'id'), 'absent')`, { id: ev.id })
const firstCard = (env: ContractEnv) => sql(env, `select id from public.cards order by wikipedia_title limit 1`)
const salesOf = (card: string) => `/api/marketplace/cards/${card}/sales`
const serverLog = () => readFileSync(new URL('../../.cache/logs/next-plain.log', import.meta.url), 'utf8').split('\n')

export const stripeWebhook: RouteSpec = {
  method: 'POST',
  path: '/api/stripe/webhook',
  source: 'D§7.11 · D:330 · D:1085',
  confidence: 'ajouté',
  cases: [
    {
      name: 'sans stripe-signature, signé par whsec_test_autre, corps modifié après signature, horodatage à 301 s (tolérance 300 s) → 400 '
        + 'invalid_signature exact ; aucune ligne stripe_events',
      run: async (env) => {
        const ev = event<Stripe.Customer>('customer.created', { id: cus(), object: 'customer' })
        const { payload, header } = sign(ev)
        const tampered = payload.replace('"livemode":false', '"livemode":true')
        assert.notEqual(tampered, payload)
        const other = sign(ev, 'whsec_test_autre')
        const old = sign(ev, undefined, nowS() - 301)
        for (const res of [await postRaw(env.plain, payload), await postRaw(env.plain, other.payload, other.header),
          await postRaw(env.plain, tampered, header), await postRaw(env.plain, old.payload, old.header)]) {
          await refused(res, 400, BAD_SIGNATURE, 'invalid_signature')
        }
        assert.equal(eventRow(env, ev), 'absent')
      },
    },
    {
      name: 'Review Focus, porte : serveur à porte sans aucun cookie, événement signé → 200 {received: true} (G37) ; POST /api/stripe/checkout '
        + 'sans cookie au même serveur → 401 de la porte',
      run: async (env) => {
        const ev = event<Stripe.Customer>('customer.created', { id: cus(), object: 'customer' })
        await received(await signedPost(env.gated, ev))
        assert.equal(eventRow(env, ev), 'ignored')
        const res = await fetch(`${env.gated}/api/stripe/checkout`, {
          method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: 'wb_2500' }),
        })
        assert.equal(res.status, 401)
        assert.deepEqual(await res.json(), { error: 'Accès réservé', message: 'Accès réservé' })
      },
    },
    {
      name: 'Review Focus, double crédit : completed payé wb_2500 → +2 500 ; le même corps signé renvoyé → 200, solde inchangé ; '
        + 'async_payment_succeeded de la session → 200, inchangé ; un achat, une ligne stripe du grand livre, une wb_purchased',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player({ balance: 100 })
        const [session, customer] = [cs(), cus()]
        const ev = checkoutCompleted({ uid, session, item: 'wb_2500', customer })
        const { payload, header } = sign(ev)
        await received(await postRaw(env.plain, payload, header))
        assert.equal(await wallet(env, uid), 100 + SHOP.wb_2500.wb)
        await received(await postRaw(env.plain, payload, header))
        const async = checkoutCompleted({ uid, session, item: 'wb_2500', customer, type: 'checkout.session.async_payment_succeeded' })
        await received(await hook(env, async))
        assert.equal(await wallet(env, uid), 100 + SHOP.wb_2500.wb)
        assert.deepEqual([eventRow(env, ev), eventRow(env, async)], ['applied', 'applied'])
        assert.equal(sql(env, `select count(*) || ':' || sum(wb) || ':' || sum(amount) from wm.purchases where user_id = :'u'`, { u: uid }),
          `1:${SHOP.wb_2500.wb}:${SHOP.wb_2500.cents}`)
        assert.equal(sql(env, `select count(*) from wm.wb_ledger where user_id = :'u' and reason = 'stripe'`, { u: uid }), '1')
        assert.equal((await notified(env, uid)).filter((t) => t === 'wb_purchased').length, 1)
        assert.equal(customerOf(env, uid), customer)
      }),
    },
    {
      name: 'Review Focus, Pro allumé : subscription.created active → is_pro ; paquet Pro du jour (15 cartes, aucune C), détail des ventes 200, '
        + '10 enchères, quota de 10 défis, régénération à 180 s ; pro_started',
      timeout: 30_000,
      run: (env) => withPlayers(env, async (player) => {
        const uid = player({ humanVerified: true })
        const t = nowS()
        await received(await hook(env, subscriptionEvent({ id: sub(), uid, status: 'active', type: 'created', created: t, periodEnd: t + 30 * DAY })))
        const state = await me(env, uid)
        assert.deepEqual([state.is_pro, state.has_customer, state.subscription?.status], [true, true, 'active'])
        assert.equal((await ok(await api(env, '/api/packs/pro-daily', { uid }), z.object({ eligible: z.boolean() }))).eligible, true)
        const { cards } = await ok(await send(env, 'POST', '/api/packs/pro-daily', uid),
          z.object({ cards: z.array(z.object({ snapshot_rarity: z.string() })) }))
        assert.equal(cards.length, 15)
        assert.ok(cards.every((c) => c.snapshot_rarity !== 'C'), JSON.stringify(cards))
        await ok(await api(env, salesOf(firstCard(env)), { uid }), z.object({ sales: z.array(z.unknown()) }))
        assert.equal((await ok(await api(env, '/api/marketplace/mine', { uid }), z.object({ maxConcurrentAuctions: z.int() }))).maxConcurrentAuctions, 10)
        assert.equal((await ok(await api(env, '/api/battles', { uid }), z.object({ challenge_quota: z.object({ limit: z.int() }) })))
          .challenge_quota.limit, 10)
        // Stock vidé et horloge posée : next_regen_at n'est défini que sous le plafond, depuis la dernière régénération.
        assert.equal(sql(env, `update public.profiles set packs_remaining = 0, packs_last_regen_at = now() where id = :'u';
select extract(epoch from wm.next_regen_at(p) - p.packs_last_regen_at)::int from public.profiles p where id = :'u'`, { u: uid }), '180')
        assert.ok((await notified(env, uid)).includes('pro_started'))
      }),
    },
    {
      name: 'Review Focus, Pro éteint : updated past_due → is_pro faux, détail des ventes 403 exact ; active puis deleted → faux ; updated active '
        + 'plus ancien, puis de la même seconde que deleted (G44), reçus après → stale, reste faux ; pro_started et pro_ended',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const [id, customer, t, card] = [sub(), cus(), nowS(), firstCard(env)]
        const at = (status: Stripe.Subscription.Status, type: 'created' | 'updated' | 'deleted', dt: number) =>
          subscriptionEvent({ id, uid, customer, status, type, created: t + dt, periodEnd: t + 30 * DAY })
        const pro = async () => (await me(env, uid)).is_pro
        await received(await hook(env, at('active', 'created', 0)))
        assert.equal(await pro(), true)
        await received(await hook(env, at('past_due', 'updated', 1)))
        assert.equal(await pro(), false)
        await refused(await api(env, salesOf(card), { uid }), 403, 'Fonction réservée aux membres Pro', 'pro_required')
        await received(await hook(env, at('active', 'updated', 2)))
        assert.equal(await pro(), true)
        await received(await hook(env, at('canceled', 'deleted', 3)))
        assert.equal(await pro(), false)
        for (const dt of [2, 3]) {
          const late = at('active', 'updated', dt)
          await received(await hook(env, late))
          assert.equal(eventRow(env, late), 'stale', `updated active à t+${dt}`)
        }
        assert.equal(await pro(), false)
        const types = await notified(env, uid)
        assert.ok(types.includes('pro_started') && types.includes('pro_ended'), types.join())
      }),
    },
    {
      name: 'cancel_at_period_end → me.subscription.cancel_at_period_end vrai, fin de période de l\'item, is_pro vrai ; invoice.payment_failed '
        + '→ pro_payment_failed, Pro gardé',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const [id, customer, t] = [sub(), cus(), nowS()]
        await received(await hook(env, subscriptionEvent({ id, uid, customer, status: 'active', type: 'updated', created: t, periodEnd: t + DAY,
          cancelAtPeriodEnd: true })))
        const m = await me(env, uid)
        assert.deepEqual([m.is_pro, m.subscription?.cancel_at_period_end], [true, true])
        assert.equal(Date.parse(m.subscription?.current_period_end ?? ''), (t + DAY) * 1000)
        await received(await hook(env, invoiceEvent({ subscription: id, uid, customer, type: 'payment_failed', created: t })))
        assert.ok((await notified(env, uid)).includes('pro_payment_failed'))
        assert.equal((await me(env, uid)).is_pro, true)
      }),
    },
    {
      name: 'Review Focus, désordre : updated active puis created incomplete de la même seconde (G44) → stale, Pro ; abonnement reçu avant '
        + 'checkout.session.completed pro_monthly → un achat pro_monthly (wb 0), Pro et solde inchangés',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player({ balance: 7 })
        const [id, customer, session, t] = [sub(), cus(), cs(), nowS()]
        const snap = (status: Stripe.Subscription.Status, type: 'created' | 'updated') =>
          subscriptionEvent({ id, uid, customer, status, type, created: t, periodEnd: t + 30 * DAY })
        await received(await hook(env, snap('active', 'updated')))
        const late = snap('incomplete', 'created')
        await received(await hook(env, late))
        assert.equal(eventRow(env, late), 'stale')
        assert.equal((await me(env, uid)).is_pro, true)
        await received(await hook(env, checkoutCompleted({ uid, session, item: 'pro_monthly', customer, created: t })))
        assert.equal(sql(env, `select string_agg(item || ':' || wb, ',') from wm.purchases where user_id = :'u'`, { u: uid }), 'pro_monthly:0')
        const state = await ok(await api(env, `/api/shop?session=${session}`, { uid }), ShopState)
        assert.deepEqual([state.me.is_pro, state.me.balance, state.purchase?.item], [true, 7, 'pro_monthly'])
      }),
    },
    {
      name: 'completed non payé → 200 pending, ni achat ni crédit ; async_payment_succeeded payé de la session → +2 500',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const [session, customer] = [cs(), cus()]
        const unpaid = checkoutCompleted({ uid, session, item: 'wb_2500', customer, paid: false })
        await received(await hook(env, unpaid))
        assert.equal(eventRow(env, unpaid), 'pending')
        assert.equal(await balance(env, uid), 0)
        assert.equal(sql(env, `select count(*) from wm.purchases where user_id = :'u'`, { u: uid }), '0')
        await received(await hook(env, checkoutCompleted({ uid, session, item: 'wb_2500', customer, type: 'checkout.session.async_payment_succeeded' })))
        assert.equal(await balance(env, uid), SHOP.wb_2500.wb)
      }),
    },
    {
      name: 'Review Focus, jamais de 500 rejoué : customer.created → 200 ignored ; livemode vrai → 200 ignored, aucun crédit ; uid inconnu → '
        + '200 unresolved ; litige → 200 applied ; {id, object} signé sans type → 400 « Événement invalide »',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const dispute = `dp_bench_${benchHex()}`
        try {
          const cases = [
            [event<Stripe.Customer>('customer.created', { id: cus(), object: 'customer', metadata: { uid } }), 'ignored'],
            [{ ...checkoutCompleted({ uid, session: cs(), item: 'wb_2500' }), livemode: true }, 'ignored'],
            [checkoutCompleted({ uid: randomUUID(), session: cs(), item: 'wb_2500' }), 'unresolved'],
            [disputeEvent({ id: dispute, status: 'needs_response', type: 'created', created: nowS() }), 'applied'],
          ] as const
          for (const [ev, outcome] of cases) {
            await received(await hook(env, ev))
            assert.equal(eventRow(env, ev), outcome, ev.type)
          }
          assert.equal(await balance(env, uid), 0)
          assert.equal(sql(env, `select status from wm.stripe_disputes where id = :'d'`, { d: dispute }), 'needs_response')
          await refused(await signedPost(env.plain, { id: 'evt_bench_x', object: 'event' }), 400, 'Événement invalide', 'invalid_request')
        } finally {
          sql(env, `delete from wm.stripe_disputes where id = :'d'`, { d: dispute })
        }
      }),
    },
    {
      name: 'maintenance → 503 maintenance, Retry-After: 1, aucune ligne stripe_events ; levée → le même corps signé → 200 et le crédit',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const ev = checkoutCompleted({ uid, session: cs(), item: 'wb_2500' })
        const { payload, header } = sign(ev)
        await inMaintenance(env, async () => {
          const res = await postRaw(env.plain, payload, header)
          assert.equal(res.headers.get('retry-after'), '1')
          await refused(res, 503, MAINTENANCE, 'maintenance')
          assert.equal(eventRow(env, ev), 'absent')
        })
        await received(await postRaw(env.plain, payload, header))
        assert.deepEqual([eventRow(env, ev), await balance(env, uid)], ['applied', SHOP.wb_2500.wb])
      }),
    },
    {
      name: 'profil tenu au-delà du lock_timeout (2 s) → 503 BUSY, Retry-After: 1, ligne stripe_events annulée avec l\'effet ; relivré → 200 et le crédit',
      timeout: 30_000,
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const ev = checkoutCompleted({ uid, session: cs(), item: 'wb_2500' })
        const { payload, header } = sign(ev)
        const app = `wm_webhook_busy_${benchHex()}`
        const holder = spawn('psql', [db(env), '-qXAt', '-v', 'ON_ERROR_STOP=1', '-v', `u=${uid}`],
          { env: { ...process.env, PGAPPNAME: app }, stdio: ['pipe', 'ignore', 'ignore'] })
        const exited = once(holder, 'exit')
        holder.stdin.end(`begin;\nselect from public.profiles where id = :'u' for update;\nselect pg_sleep(30);\ncommit;\n`)
        try {
          for (let i = 0; sql(env, `select count(*) from pg_stat_activity where application_name = :'a' and wait_event = 'PgSleep'`, { a: app }) !== '1'; i++) {
            assert.ok(i < 200, 'verrou du profil jamais pris')
            await sleep(50)
          }
          const res = await postRaw(env.plain, payload, header)
          assert.equal(res.headers.get('retry-after'), '1')
          await refused(res, 503, BUSY, 'BUSY')
          assert.equal(eventRow(env, ev), 'absent')
        } finally {
          sql(env, `select pg_terminate_backend(pid) from pg_stat_activity where application_name = :'a'`, { a: app })
          await exited
        }
        await received(await postRaw(env.plain, payload, header))
        assert.deepEqual([eventRow(env, ev), await balance(env, uid)], ['applied', SHOP.wb_2500.wb])
      }),
    },
    {
      name: 'journal du serveur : une ligne aux clés exactes par requête, signature refusée comprise ; ni whsec_, ni t= ni v1= de l\'en-tête, ni l\'uid',
      run: (env) => withPlayers(env, async (player) => {
        const uid = player()
        const ev = checkoutCompleted({ uid, session: cs(), item: 'wb_2500', paid: false })
        const { payload, header } = sign(ev)
        const vercelId = randomUUID()
        await received(await postRaw(env.plain, payload, header))
        await refused(await postRaw(env.plain, payload, `${header}0`, { 'x-vercel-id': vercelId }), 400, BAD_SIGNATURE, 'invalid_signature')
        // Journal du serveur lancé par le banc lui-même : ce cas ne vaut que si la suite démarre son propre serveur.
        const lines = serverLog()
        const good = lines.find((l) => l.includes(ev.id))
        const bad = lines.find((l) => l.includes(vercelId))
        for (const line of [good, bad]) {
          assert.ok(line)
          assert.deepEqual(Object.keys(JSON.parse(line)), LOG_KEYS)
          for (const secret of ['whsec_', ...header.split(','), uid]) assert.ok(!line.includes(secret), secret)
        }
        const g = JSON.parse(good ?? '') as Record<string, unknown>
        assert.deepEqual(g, { ...g, route: '/api/stripe/webhook', status: 200, rpc: 'stripe_apply', pg_code: null, event_type: ev.type,
          event_id: ev.id, duplicate: false, outcome: 'pending', vercel_id: null })
        const b = JSON.parse(bad ?? '') as Record<string, unknown>
        assert.deepEqual(b, { ...b, status: 400, event_type: null, event_id: null, duplicate: null, outcome: null, vercel_id: vercelId })
      }),
    },
  ],
}

export const stripe: RouteSpec[] = [shop, stripeCheckout, stripePortal, graceStatus, stripeWebhook]
