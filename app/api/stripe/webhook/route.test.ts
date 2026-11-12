import Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// server-only lève hors de la condition react-server ; lib/route.ts charge aussi les deux clients et access.
vi.mock('server-only', () => ({}))
const rpc = vi.fn()
const admin = vi.fn(() => ({ schema: () => ({ rpc }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: admin }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/access', () => ({ accessDenied: vi.fn() }))

const { POST } = await import('./route')
const { BUSY, INTERNAL } = await import('@/lib/route')

// Littéraux factices du dépôt public (M2-R1).
const SECRET = 'whsec_test_unit_fake'
const EVENT = { id: 'evt_bench_unit', object: 'event', type: 'checkout.session.completed', created: 1, livemode: false, data: { object: {} } }
const payload = JSON.stringify(EVENT)
const post = (body = payload, header: string | null = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET })) =>
  POST(new Request('http://localhost/api/stripe/webhook', { method: 'POST', body, headers: header === null ? {} : { 'stripe-signature': header } }))
const pgError = (code: string, extra: Record<string, unknown> = {}) => ({ data: null, error: { code, message: 'relation secrète', ...extra } })

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', SECRET)
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
const line = () => JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>

describe('POST /api/stripe/webhook', () => {
  it('STRIPE_WEBHOOK_SECRET absent → 503 stripe_disabled, Retry-After, aucune RPC', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', undefined)
    const res = await post()
    expect([res.status, res.headers.get('retry-after')]).toEqual([503, '1'])
    expect(await res.json()).toStrictEqual({ code: 'stripe_disabled', error: 'Paiement non configuré.', message: 'Paiement non configuré.' })
    expect(admin).not.toHaveBeenCalled()
  })

  it.each([
    ['sans en-tête', () => post(payload, null)],
    ['autre secret', () => post(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_autre' }))],
    ['hors tolérance (301 s)', () => post(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Date.now() / 1000 - 301 }))],
  ])('%s → 400 invalid_signature, aucun client ni RPC, journal sans événement', async (_, send) => {
    const res = await send()
    expect(res.status).toBe(400)
    expect(await res.json()).toStrictEqual({ code: 'invalid_signature', error: 'Signature Stripe invalide', message: 'Signature Stripe invalide' })
    expect(admin).not.toHaveBeenCalled()
    expect(line()).toMatchObject({ status: 400, event_id: null, event_type: null, pg_code: null })
  })

  it('signé mais illisible (pas du JSON, événement v2 « thin ») → même 400 invalid_signature, aucune RPC, event_type « unparsable » au journal', async () => {
    for (const body of ['x{secret', JSON.stringify({ id: 'evtn_x', object: 'v2.core.event', type: 'x' })]) {
      const res = await post(body)
      expect(res.status).toBe(400)
      expect(await res.json()).toStrictEqual({ code: 'invalid_signature', error: 'Signature Stripe invalide', message: 'Signature Stripe invalide' })
      expect(line()).toMatchObject({ status: 400, event_type: 'unparsable', event_id: null, pg_code: null })
      expect(String(log.mock.calls.at(-1)?.[0])).not.toContain('secret')
    }
    expect(admin).not.toHaveBeenCalled()
  })

  it('signé → une RPC stripe_apply avec l\'événement ; 200 {received: true} ; ligne aux clés exactes, sans secret ni signature', async () => {
    rpc.mockResolvedValueOnce({ data: { duplicate: false, outcome: 'applied' }, error: null })
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET })
    const res = await post(payload, header)
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ received: true })
    expect(rpc.mock.calls).toStrictEqual([['stripe_apply', { p_event: EVENT }]])
    const text = String(log.mock.calls.at(-1)?.[0])
    expect(Object.keys(JSON.parse(text))).toStrictEqual(
      ['route', 'status', 'ms', 'rpc', 'pg_code', 'event_type', 'event_id', 'duplicate', 'outcome', 'vercel_id'])
    expect(line()).toMatchObject({ route: '/api/stripe/webhook', status: 200, rpc: 'stripe_apply', pg_code: null,
      event_type: EVENT.type, event_id: EVENT.id, duplicate: false, outcome: 'applied', vercel_id: null })
    for (const s of [SECRET, header, header.split(',')[1]]) expect(text).not.toContain(s)
  })

  it('doublon → 200 {received: true}, duplicate vrai au journal', async () => {
    rpc.mockResolvedValueOnce({ data: { duplicate: true, outcome: null }, error: null })
    expect(await (await post()).json()).toStrictEqual({ received: true })
    expect(line()).toMatchObject({ duplicate: true, outcome: null })
  })

  it.each(['55P03', '40P01', '57014', 'PGRST003'])('%s → 503 BUSY, Retry-After: 1', async (code) => {
    rpc.mockResolvedValueOnce(pgError(code))
    const res = await post()
    expect([res.status, res.headers.get('retry-after')]).toEqual([503, '1'])
    expect(await res.json()).toStrictEqual({ code: 'BUSY', error: BUSY, message: BUSY })
    expect(line().pg_code).toBe(code)
  })

  it('P0001 de wm.raise_err (maintenance 503, événement invalide 400) → recopié', async () => {
    const m = 'Maintenance en cours, reviens dans quelques minutes.'
    rpc.mockResolvedValueOnce(pgError('P0001', { details: JSON.stringify({ status: 503, code: 'maintenance', error: m, message: m }) }))
    const res = await post()
    expect([res.status, res.headers.get('retry-after')]).toEqual([503, '1'])
    expect(await res.json()).toStrictEqual({ code: 'maintenance', error: m, message: m })
    const bad = 'Événement invalide'
    rpc.mockResolvedValueOnce(pgError('P0001', { details: JSON.stringify({ status: 400, code: 'invalid_request', error: bad, message: bad }) }))
    const refused = await post()
    expect([refused.status, refused.headers.get('retry-after')]).toEqual([400, null])
    expect(await refused.json()).toStrictEqual({ code: 'invalid_request', error: bad, message: bad })
    expect(line()).toMatchObject({ status: 400, pg_code: 'P0001', duplicate: null, outcome: null })
  })

  it.each([['null', null], ['une chaîne', 'ok'], ['un nombre', 1]])('stripe_apply rend %s → 200 {received: true}, outcome « unknown », duplicate faux (jamais un 500 rejoué)', async (_, data) => {
    rpc.mockResolvedValueOnce({ data, error: null })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ received: true })
    expect(line()).toMatchObject({ status: 200, pg_code: null, duplicate: false, outcome: 'unknown' })
  })

  it('autre erreur de base, ou RPC qui lève → 500 INTERNAL sans détail (Stripe réessaie)', async () => {
    rpc.mockResolvedValueOnce(pgError('23505'))
    const res = await post()
    expect([res.status, res.headers.get('retry-after')]).toEqual([500, null])
    expect(await res.json()).toStrictEqual({ error: INTERNAL, message: INTERNAL })
    rpc.mockRejectedValueOnce(new Error('relation secrète'))
    const thrown = await post()
    expect(thrown.status).toBe(500)
    expect(await thrown.text()).not.toContain('secrète')
    expect(line()).toMatchObject({ status: 500, event_id: EVENT.id, pg_code: 'thrown' })
    const text = String(log.mock.calls.at(-1)?.[0])
    expect(Object.keys(JSON.parse(text))).toStrictEqual(
      ['route', 'status', 'ms', 'rpc', 'pg_code', 'event_type', 'event_id', 'duplicate', 'outcome', 'vercel_id'])
    expect(text).not.toContain('secrète')
  })
})
