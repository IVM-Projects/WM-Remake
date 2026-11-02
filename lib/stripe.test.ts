import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResult } from '@/lib/route'

// server-only lève hors de la condition react-server, et lib/stripe.ts l'importe lui-même.
vi.mock('server-only', () => ({}))
const rpc = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ schema: () => ({ rpc }) }) }))
// lib/route.ts (toHttpError) charge ces deux modules.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/access', () => ({ accessDenied: vi.fn() }))

// Le vrai SDK garde ses statiques (errors, webhooks) ; seul le client est simulé.
const fake = vi.hoisted(() => ({
  ctor: vi.fn(),
  api: {
    customers: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { cancel: vi.fn() },
  },
}))
vi.mock('stripe', async (importOriginal) => {
  const Real = (await importOriginal<typeof import('stripe')>()).default
  class FakeStripe {
    static errors = Real.errors
    static webhooks = Real.webhooks
    constructor(...a: unknown[]) {
      fake.ctor(...a)
      return fake.api
    }
  }
  return { default: FakeStripe }
})

const { default: Stripe } = await import('stripe')
const S = await import('@/lib/stripe')
const { toHttpError } = await import('@/lib/route')
const { ShopQuery } = await import('@/lib/schemas')
const { api, ctor } = fake

const UID = '00000000-0000-4000-8000-000000000001'
const KEY = 'sk_test_bench_fake'
const EMAIL = 'joueur@example.invalid'
const ORIGIN = 'https://x.test'
const ok = (data: unknown): RpcResult => ({ data, error: null })
const sqlErr = (status: number, code: string, message: string): RpcResult =>
  ({ data: null, error: { code: 'P0001', message, details: JSON.stringify({ status, code, error: message, message }) } })
const rpcs = (map: Record<string, RpcResult>) => rpc.mockImplementation(async (fn: string) => map[fn] ?? ok(null))
const body = (r: RpcResult) => toHttpError(r.error!)
const hash16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const logs = () => [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].map((c) => c.join(' ')).join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubEnv('STRIPE_SECRET_KEY', KEY)
  vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY', 'price_test_bench_pro')
  vi.stubEnv('STRIPE_PRICE_WB_2500', 'price_test_bench_wb')
  vi.stubEnv('STRIPE_API_URL', '')
  api.customers.create.mockResolvedValue({ id: 'cus_bench_new' })
  api.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_bench_1', url: 'https://checkout.stripe.com/c/pay/cs_test_bench_1' })
  api.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/test_bench_1' })
  api.subscriptions.cancel.mockResolvedValue({ status: 'canceled' })
})

describe('stripeClient et apiTarget', () => {
  it('apiTarget(http://127.0.0.1:54321) → host, port, protocol http', () => {
    expect(S.apiTarget('http://127.0.0.1:54321')).toStrictEqual({ host: '127.0.0.1', port: '54321', protocol: 'http' })
  })

  it('apiTarget sans port → celui du schéma ; autre schéma ou URL illisible → null', () => {
    expect(S.apiTarget('http://bench.test')).toStrictEqual({ host: 'bench.test', port: '80', protocol: 'http' })
    expect(S.apiTarget('https://bench.test')).toStrictEqual({ host: 'bench.test', port: '443', protocol: 'https' })
    expect(S.apiTarget('ftp://bench.test:21')).toBeNull()
    expect(S.apiTarget('pas une url')).toBeNull()
  })

  it('STRIPE_API_URL illisible avec une clé de test → aucun client, bad_api_url sans l\'URL', () => {
    vi.stubEnv('STRIPE_API_URL', 'ftp://secret-host.test')
    expect(S.stripeClient()).toBeNull()
    expect(ctor).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('{"stripe":"bad_api_url"}')
    expect(logs()).not.toContain('secret-host')
  })

  it('rk_test_ → STRIPE_API_URL suivie', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_bench_fake')
    vi.stubEnv('STRIPE_API_URL', 'http://127.0.0.1:54321')
    S.stripeClient()
    expect(ctor.mock.lastCall?.[1]).toMatchObject({ host: '127.0.0.1', port: '54321', protocol: 'http' })
  })

  it('clé live → STRIPE_API_URL ignorée (hôte Stripe), api_url_ignored journalisé une fois, sans l\'URL', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_bench_fake')
    vi.stubEnv('STRIPE_API_URL', 'http://evil-host.test:8080')
    S.stripeClient()
    S.stripeClient()
    expect(ctor.mock.calls).toStrictEqual([
      ['sk_live_bench_fake', { apiVersion: '2026-10-28.endive', maxNetworkRetries: 1, timeout: 10_000 }],
      ['sk_live_bench_fake', { apiVersion: '2026-10-28.endive', maxNetworkRetries: 1, timeout: 10_000 }],
    ])
    expect(vi.mocked(console.error).mock.calls).toStrictEqual([['{"stripe":"api_url_ignored"}']])
    expect(logs()).not.toContain('evil-host')
  })

  it('sans STRIPE_SECRET_KEY → null, aucun client', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(S.stripeClient()).toBeNull()
    expect(ctor).not.toHaveBeenCalled()
  })

  it('version d\'API épinglée ; STRIPE_API_URL vide → hôte par défaut, posée → hôte du banc', () => {
    S.stripeClient()
    expect(ctor).toHaveBeenLastCalledWith(KEY, { apiVersion: '2026-10-28.endive', maxNetworkRetries: 1, timeout: 10_000 })
    vi.stubEnv('STRIPE_API_URL', 'http://127.0.0.1:54321')
    S.stripeClient()
    expect(ctor).toHaveBeenLastCalledWith(KEY, {
      apiVersion: '2026-10-28.endive', maxNetworkRetries: 1, timeout: 10_000, host: '127.0.0.1', port: '54321', protocol: 'http',
    })
  })
})

describe('checkoutParams', () => {
  const base = { uid: UID, customer: 'cus_bench_1', origin: ORIGIN }

  it('pro_monthly : abonnement, consentement et renonciation, URLs de retour, locale fr', () => {
    const p = S.checkoutParams({ ...base, item: 'pro_monthly', price: 'price_test_bench_pro' })
    expect(p).toStrictEqual({
      mode: 'subscription',
      customer: 'cus_bench_1',
      client_reference_id: UID,
      metadata: { uid: UID, item: 'pro_monthly' },
      line_items: [{ price: 'price_test_bench_pro', quantity: 1 }],
      locale: 'fr',
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message:
        'J\'accepte les [conditions d\'utilisation](https://x.test/terms) et je demande l\'accès immédiat au contenu numérique acheté : je renonce ainsi à mon droit de rétractation.' } },
      success_url: 'https://x.test/pulls?shop=success&session={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://x.test/pulls?shop=cancel',
      subscription_data: { metadata: { uid: UID } },
    })
    expect(p).not.toHaveProperty('payment_intent_data')
  })

  it('wb_2500 : paiement, metadata du PaymentIntent, pas de subscription_data', () => {
    const p = S.checkoutParams({ ...base, item: 'wb_2500', price: 'price_test_bench_wb' })
    expect(p.mode).toBe('payment')
    expect(p.payment_intent_data).toStrictEqual({ metadata: { uid: UID, item: 'wb_2500' } })
    expect(p).not.toHaveProperty('subscription_data')
    expect(p.consent_collection).toStrictEqual({ terms_of_service: 'required' })
  })
})

describe('checkoutCall', () => {
  const call = S.checkoutCall(ORIGIN)
  const args = (over: Record<string, unknown> = {}) => ({ p_uid: UID, p_item: 'wb_2500', p_idem: 'k1', ...over })

  it('sans clé → 503 stripe_disabled, lu par toHttpError ; aucun appel Stripe', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    rpcs({ stripe_checkout_prepare: ok({ customer_id: 'cus_bench_1', email: EMAIL }) })
    const r = await call(args())
    expect(body(r)).toStrictEqual({ status: 503, body: { code: 'stripe_disabled', error: 'Paiement non configuré.', message: 'Paiement non configuré.' }, retryAfter: 1 })
    expect(ctor).not.toHaveBeenCalled()
  })

  it('Price absent → 503 stripe_disabled', async () => {
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY', '')
    rpcs({ stripe_checkout_prepare: ok({ customer_id: 'cus_bench_1', email: EMAIL }) })
    expect(body(await call(args({ p_item: 'pro_monthly' }))).body.code).toBe('stripe_disabled')
    expect(api.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('arguments de la RPC → exactement { p_uid, p_item }, même avec p_idem dans args', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: 'cus_bench_1', email: EMAIL }) })
    await call(args({ p_extra: 'x' }))
    expect(rpc.mock.calls[0]).toStrictEqual(['stripe_checkout_prepare', { p_uid: UID, p_item: 'wb_2500' }])
  })

  it('erreur de la RPC (409) rendue telle quelle, aucun appel Stripe', async () => {
    const e = sqlErr(409, 'already_subscribed', 'Tu as déjà un abonnement Pro : gère-le depuis les paramètres.')
    rpcs({ stripe_checkout_prepare: e })
    expect(await call(args({ p_item: 'pro_monthly' }))).toBe(e)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('Customer existant → réutilisé ; idempotencyKey checkout:<uid>:<item>:<clé> ; rend { url }', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: 'cus_bench_1', email: EMAIL }) })
    const r = await call(args({ p_item: 'pro_monthly' }))
    expect(r).toStrictEqual({ data: { url: 'https://checkout.stripe.com/c/pay/cs_test_bench_1' }, error: null })
    expect(api.customers.create).not.toHaveBeenCalled()
    const [params, opts] = api.checkout.sessions.create.mock.calls[0]
    expect(params).toStrictEqual(S.checkoutParams({ uid: UID, item: 'pro_monthly', customer: 'cus_bench_1', price: 'price_test_bench_pro', origin: ORIGIN }))
    expect(opts).toStrictEqual({ idempotencyKey: `checkout:${UID}:pro_monthly:k1` })
  })

  it('sans Idempotency-Key → aucune clé d\'idempotence pour la session', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: 'cus_bench_1', email: EMAIL }) })
    await call(args({ p_idem: null }))
    expect(api.checkout.sessions.create.mock.calls[0][1]).toStrictEqual({ idempotencyKey: undefined })
  })

  it('sans Customer → customers.create (clé customer:<uid>:<16 hex de sha256(email)>), puis stripe_customer_set', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: null, email: EMAIL }), stripe_customer_set: ok('cus_bench_new') })
    const r = await call(args())
    expect(api.customers.create).toHaveBeenCalledWith({ email: EMAIL, metadata: { uid: UID } }, { idempotencyKey: `customer:${UID}:${hash16(EMAIL)}` })
    expect(hash16(EMAIL)).toMatch(/^[0-9a-f]{16}$/)
    expect(rpc.mock.calls[1]).toStrictEqual(['stripe_customer_set', { p_uid: UID, p_customer_id: 'cus_bench_new' }])
    expect(api.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_bench_new')
    expect(r.error).toBeNull()
  })

  it('stripe_customer_set rend le Customer posé avant (course) → celui-là est utilisé', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: null, email: EMAIL }), stripe_customer_set: ok('cus_bench_first') })
    await call(args())
    expect(api.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_bench_first')
  })

  it('e-mail changé → autre clé d\'idempotence du Customer', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: null, email: EMAIL }), stripe_customer_set: ok('cus_bench_new') })
    await call(args())
    rpcs({ stripe_checkout_prepare: ok({ customer_id: null, email: 'autre@example.invalid' }), stripe_customer_set: ok('cus_bench_new') })
    await call(args())
    const [k1, k2] = api.customers.create.mock.calls.map((c) => c[1].idempotencyKey)
    expect(k1).not.toBe(k2)
    expect(k2).toBe(`customer:${UID}:${hash16('autre@example.invalid')}`)
  })

  it('stripe_customer_set en erreur → son erreur rendue, aucune session créée', async () => {
    const e = sqlErr(401, 'unauthorized', 'Session expirée, reconnecte-toi.')
    rpcs({ stripe_checkout_prepare: ok({ customer_id: null, email: EMAIL }), stripe_customer_set: e })
    expect(await call(args())).toBe(e)
    expect(api.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('stripe_customer_set rend null (Customer d\'un autre joueur) → 502, jamais lu comme « pas de Customer »', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: null, email: EMAIL }), stripe_customer_set: ok(null) })
    const r = await call(args())
    expect(body(r)).toMatchObject({ status: 502, body: { code: 'stripe_unavailable' } })
    expect(api.customers.create).toHaveBeenCalledTimes(1)
    expect(api.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('erreur du SDK → 502 stripe_unavailable, journal sans la clé ni l\'e-mail', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: null, email: EMAIL }) })
    api.customers.create.mockRejectedValue(new Error(`Invalid email ${EMAIL} for key ${KEY}`))
    const r = await call(args())
    expect(body(r)).toStrictEqual({ status: 502, body: {
      code: 'stripe_unavailable', error: 'Le paiement est indisponible, réessaie dans un instant.', message: 'Le paiement est indisponible, réessaie dans un instant.',
    } })
    expect(console.error).toHaveBeenCalledWith('{"stripe":"api_failed","op":"checkout"}')
    expect(logs()).not.toContain(EMAIL)
    expect(logs()).not.toContain(KEY)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('session sans url → 502 stripe_unavailable, jamais un 200 { url: null }', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: 'cus_bench_1', email: EMAIL }) })
    api.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_bench_1', url: null })
    const r = await call(args())
    expect(r.data).toBeNull()
    expect(body(r)).toMatchObject({ status: 502, body: { code: 'stripe_unavailable' } })
  })

  it('erreur du SDK à la création de la session → 502', async () => {
    rpcs({ stripe_checkout_prepare: ok({ customer_id: 'cus_bench_1', email: EMAIL }) })
    api.checkout.sessions.create.mockRejectedValue(new Error('down'))
    expect(body(await call(args())).status).toBe(502)
  })
})

describe('portalCall', () => {
  const call = S.portalCall(ORIGIN)

  it('Portail du Customer, retour /settings, locale fr', async () => {
    rpcs({ stripe_portal_prepare: ok({ customer_id: 'cus_bench_1' }) })
    const r = await call({ p_uid: UID })
    expect(r).toStrictEqual({ data: { url: 'https://billing.stripe.com/p/session/test_bench_1' }, error: null })
    expect(rpc.mock.calls[0]).toStrictEqual(['stripe_portal_prepare', { p_uid: UID }])
    expect(api.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_bench_1', return_url: 'https://x.test/settings', locale: 'fr' })
  })

  it('session de Portail sans url → 502 stripe_unavailable', async () => {
    rpcs({ stripe_portal_prepare: ok({ customer_id: 'cus_bench_1' }) })
    api.billingPortal.sessions.create.mockResolvedValue({ id: 'bps_bench_1' })
    expect(body(await call({ p_uid: UID }))).toMatchObject({ status: 502, body: { code: 'stripe_unavailable' } })
  })

  it('404 no_customer rendu tel quel ; sans clé → 503 ; SDK en erreur → 502', async () => {
    const e = sqlErr(404, 'no_customer', 'Aucun abonnement à gérer')
    rpcs({ stripe_portal_prepare: e })
    expect(await call({ p_uid: UID })).toBe(e)
    rpcs({ stripe_portal_prepare: ok({ customer_id: 'cus_bench_1' }) })
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(body(await call({ p_uid: UID })).body.code).toBe('stripe_disabled')
    vi.stubEnv('STRIPE_SECRET_KEY', KEY)
    api.billingPortal.sessions.create.mockRejectedValue(new Error('down'))
    expect(body(await call({ p_uid: UID })).status).toBe(502)
    expect(console.error).toHaveBeenCalledWith('{"stripe":"api_failed","op":"portal"}')
  })
})

describe('cancelSubscriptionsFor', () => {
  const missing = () => new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: 'No such subscription' })

  it('sans abonnement → true sans client (STRIPE_SECRET_KEY absente)', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: [] }) })
    expect(await S.cancelSubscriptionsFor(UID)).toBe(true)
    expect(ctor).not.toHaveBeenCalled()
    expect(rpc.mock.calls).toStrictEqual([['stripe_cancel_targets', { p_user_id: UID }]])
  })

  it('abonnement mais clé absente → false, stripe_cancel_done non appelée', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: ['sub_bench_1'] }) })
    expect(await S.cancelSubscriptionsFor(UID)).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('succès → stripe_cancel_done appelée avec les ids résiliés → true', async () => {
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: ['sub_bench_1', 'sub_bench_2'] }), stripe_cancel_done: ok({ ok: true, stripe_pending: false }) })
    expect(await S.cancelSubscriptionsFor(UID)).toBe(true)
    expect(api.subscriptions.cancel.mock.calls).toStrictEqual([['sub_bench_1'], ['sub_bench_2']])
    expect(rpc.mock.calls[1]).toStrictEqual(['stripe_cancel_done', { p_user_id: UID, p_subscription_ids: ['sub_bench_1', 'sub_bench_2'] }])
  })

  it('resource_missing → compté comme résilié, true', async () => {
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: ['sub_bench_1'] }), stripe_cancel_done: ok({ ok: true, stripe_pending: false }) })
    api.subscriptions.cancel.mockRejectedValue(missing())
    expect(await S.cancelSubscriptionsFor(UID)).toBe(true)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('500 → false, stripe_cancel_done non appelée, journal op cancel', async () => {
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: ['sub_bench_fail_1'] }) })
    api.subscriptions.cancel.mockRejectedValue(new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'bench' }))
    expect(await S.cancelSubscriptionsFor(UID)).toBe(false)
    expect(rpc.mock.calls.map((c) => c[0])).toStrictEqual(['stripe_cancel_targets'])
    expect(console.error).toHaveBeenCalledWith('{"stripe":"api_failed","op":"cancel"}')
  })

  it('une autre StripeInvalidRequestError (pas resource_missing) → false', async () => {
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: ['sub_bench_1'] }) })
    api.subscriptions.cancel.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'parameter_invalid', message: 'x' }))
    expect(await S.cancelSubscriptionsFor(UID)).toBe(false)
  })

  it('stripe_cancel_done qui rend stripe_pending: true → false', async () => {
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: ['sub_bench_1'] }), stripe_cancel_done: ok({ ok: true, stripe_pending: true }) })
    expect(await S.cancelSubscriptionsFor(UID)).toBe(false)
  })

  it('RPC en erreur → false', async () => {
    rpcs({ stripe_cancel_targets: sqlErr(500, 'x', 'x') })
    expect(await S.cancelSubscriptionsFor(UID)).toBe(false)
    rpcs({ stripe_cancel_targets: ok({ subscription_ids: ['sub_bench_1'] }), stripe_cancel_done: sqlErr(500, 'x', 'x') })
    expect(await S.cancelSubscriptionsFor(UID)).toBe(false)
  })
})

describe('ShopQuery', () => {
  it.each(['cs_test_bench_k', 'cs_test_a1B2', 'cs_live_a1'])('%s accepté', (session) => {
    expect(ShopQuery.safeParse({ session }).success).toBe(true)
  })
  it.each(['cs_x', 'cs_test_', 'cs_test_a-b', `cs_test_${'a'.repeat(201)}`])('%s refusé', (session) => {
    expect(ShopQuery.safeParse({ session }).success).toBe(false)
  })
  it('session facultative', () => {
    expect(ShopQuery.parse({})).toStrictEqual({})
  })
})

describe('verifyEvent', () => {
  const secret = 'whsec_test_bench_fake'
  const payload = JSON.stringify({ id: 'evt_bench_1', object: 'event', type: 'checkout.session.completed', data: { object: {} } })

  it('corps signé → l\'événement', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret })
    expect(S.verifyEvent(payload, header, secret).id).toBe('evt_bench_1')
  })

  it('un octet changé → lève', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret })
    expect(() => S.verifyEvent(payload.replace('evt_bench_1', 'evt_bench_2'), header, secret)).toThrow()
  })

  it('horodatage de 301 s → lève ; sans en-tête → lève', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) - 301 })
    expect(() => S.verifyEvent(payload, header, secret)).toThrow()
    expect(() => S.verifyEvent(payload, null, secret)).toThrow()
  })
})
