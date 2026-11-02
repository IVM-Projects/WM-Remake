import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { SHOP } from '../../lib/shop.ts'
import { resetStripeRequests, STRIPE, stripeRequests } from '../harness.ts'
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

export const stripe: RouteSpec[] = [shop, stripeCheckout, stripePortal, graceStatus]
