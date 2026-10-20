import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { z } from 'zod'

const getClaims = vi.fn()
const rpc = vi.fn()
const schema = vi.fn(() => ({ rpc }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getClaims } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ schema }) }))

const { route, toHttpError, fail, UNAUTHORIZED, BUSY, INTERNAL } = await import('@/lib/route')

const ctx = { params: Promise.resolve({}) }
const req = (init: { method?: string; body?: string; headers?: Record<string, string>; query?: string } = {}) =>
  new NextRequest(`http://localhost/api/t${init.query ?? ''}`, { method: init.method ?? 'GET', body: init.body, headers: init.headers })
const signedIn = (sub = 'u1') => getClaims.mockResolvedValue({ data: { claims: { sub } }, error: null })
const pgError = (error: { code: string; message?: string; details?: string | null }) =>
  rpc.mockResolvedValue({ data: null, error: { message: 'm', details: null, hint: null, ...error } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  getClaims.mockResolvedValue({ data: null, error: null })
  rpc.mockResolvedValue({ data: { ok: true }, error: null })
})

describe('route()', () => {
  it('sans claims → 401, RPC non appelée', async () => {
    const res = await route({ fn: 'fn' })(req(), ctx)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'unauthorized', error: UNAUTHORIZED, message: UNAUTHORIZED })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('claims sub u1 → rpc(fn, {p_uid}) sur le schéma wm, 200 avec data', async () => {
    signedIn()
    const res = await route({ fn: 'fn' })(req(), ctx)
    expect(schema).toHaveBeenCalledWith('wm')
    expect(rpc).toHaveBeenCalledWith('fn', { p_uid: 'u1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('entrée zod invalide → 400 invalid_request en français, RPC non appelée', async () => {
    signedIn()
    const res = await route({ fn: 'fn', input: z.object({ n: z.number() }) })(req({ method: 'POST', body: '{"n":"x"}' }), ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('invalid_request')
    expect(body.message).toMatch(/attendu/)
    expect(body.error).toBe(body.message)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('corps illisible → 400 Corps JSON invalide', async () => {
    signedIn()
    const res = await route({ fn: 'fn', input: z.object({}) })(req({ method: 'POST', body: '{' }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'invalid_request', error: 'Corps JSON invalide', message: 'Corps JSON invalide' })
  })

  it('GET : entrée lue dans la query string et passée à args', async () => {
    signedIn()
    const handler = route({ fn: 'fn', input: z.object({ page: z.coerce.number() }), args: (i, c) => ({ p_uid: c.uid, p_page: i.page }) })
    await handler(req({ query: '?page=2' }), ctx)
    expect(rpc).toHaveBeenCalledWith('fn', { p_uid: 'u1', p_page: 2 })
  })

  it('P0001 à détail JSON → statut recopié, corps sans clé status', async () => {
    signedIn()
    pgError({ code: 'P0001', details: '{"status":409,"code":"bid_too_low","min":110,"error":"m","message":"m"}' })
    const res = await route({ fn: 'fn' })(req(), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ code: 'bid_too_low', min: 110, error: 'm', message: 'm' })
  })

  it('P0001 429 avec retry_after → Retry-After', async () => {
    signedIn()
    pgError({ code: 'P0001', details: '{"status":429,"rate_limited":true,"retry_after":3,"error":"m","message":"m"}' })
    const res = await route({ fn: 'fn' })(req(), ctx)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('3')
  })

  it.each(['55P03', '57014'])('%s → 503 BUSY + Retry-After: 1', async (code) => {
    signedIn()
    pgError({ code })
    const res = await route({ fn: 'fn' })(req(), ctx)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'BUSY', error: BUSY, message: BUSY })
    expect(res.headers.get('Retry-After')).toBe('1')
  })

  it.each([
    { code: 'XX000', message: 'relation secrète' },
    { code: 'P0001', message: 'relation secrète', details: 'pas du JSON' },
    { code: 'P0001', message: 'relation secrète', details: '{"code":"x"}' },
  ])('erreur inconnue %j → 500 générique sans détail Postgres', async (e) => {
    signedIn()
    pgError(e)
    const res = await route({ fn: 'fn' })(req(), ctx)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: INTERNAL, message: INTERNAL })
    expect(text).not.toContain('relation')
  })

  it('exception (réseau, configuration) → 500 générique', async () => {
    signedIn()
    rpc.mockRejectedValue(new Error('relation secrète'))
    const res = await route({ fn: 'fn' })(req(), ctx)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('relation')
  })

  it('x-wiki-calendar-tz invalide → ctx.tz Europe/Paris', async () => {
    signedIn()
    const args = vi.fn(() => ({}))
    await route({ fn: 'fn', args })(req({ headers: { 'x-wiki-calendar-tz': '../../etc/passwd' } }), ctx)
    expect(args).toHaveBeenCalledWith(undefined, expect.objectContaining({ tz: 'Europe/Paris', uid: 'u1' }))
  })

  it('Idempotency-Key de 129 caractères → 400, 128 acceptés', async () => {
    signedIn()
    const args = vi.fn(() => ({}))
    const bad = await route({ fn: 'fn', args })(req({ headers: { 'Idempotency-Key': 'k'.repeat(129) } }), ctx)
    expect(bad.status).toBe(400)
    expect((await bad.json()).code).toBe('invalid_request')
    expect(rpc).not.toHaveBeenCalled()
    await route({ fn: 'fn', args })(req({ headers: { 'Idempotency-Key': 'k'.repeat(128) } }), ctx)
    expect(args).toHaveBeenCalledWith(undefined, expect.objectContaining({ idem: 'k'.repeat(128) }))
  })

  it('auth: false → getClaims jamais appelé, aucune clé p_uid envoyée', async () => {
    const res = await route({ fn: 'health', auth: false })(req(), ctx)
    expect(getClaims).not.toHaveBeenCalled()
    expect(rpc.mock.calls[0]).toStrictEqual(['health', {}])
    expect(res.status).toBe(200)
  })

  it('args ne peut pas remplacer p_uid', async () => {
    signedIn()
    await route({ fn: 'fn', args: () => ({ p_uid: 'evil', p_x: 1 }) })(req(), ctx)
    expect(rpc.mock.calls[0]).toStrictEqual(['fn', { p_uid: 'u1', p_x: 1 }])
  })

  it('une ligne de log JSON, uid haché', async () => {
    signedIn()
    pgError({ code: '57014' })
    await route({ fn: 'fn' })(req({ headers: { 'x-vercel-id': 'dub1::abc' } }), ctx)
    expect(console.log).toHaveBeenCalledTimes(1)
    const line = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(line).toEqual({ route: '/api/t', status: 503, ms: expect.any(Number), rpc: 'fn', pg_code: '57014',
      uid_hash: 'bb82030dbc2b', vercel_id: 'dub1::abc' })
  })

  it('POST à corps vide → input {} (pas de 400)', async () => {
    signedIn()
    const args = vi.fn(() => ({}))
    const res = await route({ fn: 'fn', input: z.looseObject({}), args })(req({ method: 'POST' }), ctx)
    expect(res.status).toBe(200)
    expect(args).toHaveBeenCalledWith({}, expect.anything())
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('GET a=1&rarity=L&rarity=UR → { a: "1", rarity: ["L", "UR"] }', async () => {
    signedIn()
    const args = vi.fn(() => ({}))
    await route({ fn: 'fn', input: z.looseObject({}), args })(req({ query: '?a=1&rarity=L&rarity=UR' }), ctx)
    expect(args).toHaveBeenCalledWith({ a: '1', rarity: ['L', 'UR'] }, expect.anything())
  })

  it('params invalide → 400 français, aucune RPC (avant la lecture du corps)', async () => {
    signedIn()
    const handler = route({ fn: 'fn', params: z.object({ userCardId: z.uuid() }), input: z.looseObject({}) })
    const res = await handler(req({ method: 'POST', body: '{' }), { params: Promise.resolve({ userCardId: 'abc' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('invalid_request')
    expect(body.message).toMatch(/UUID/)
    expect(body.message).not.toMatch(/JSON/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('params valide → ctx.params passé à args', async () => {
    signedIn()
    const id = '0b9a7c1e-4f2d-4a6b-9c3e-1d2f3a4b5c6d'
    const handler = route({ fn: 'fn', params: z.object({ userCardId: z.uuid() }), args: (_, c) => ({ p_user_card_id: c.params.userCardId }) })
    await handler(req({ method: 'POST' }), { params: Promise.resolve({ userCardId: id }) })
    expect(rpc).toHaveBeenCalledWith('fn', { p_user_card_id: id, p_uid: 'u1' })
  })

  it('idem: true → p_idem transmis (null sans en-tête), absent sans idem', async () => {
    signedIn()
    await route({ fn: 'fn', idem: true })(req({ headers: { 'Idempotency-Key': 'k1' } }), ctx)
    await route({ fn: 'fn', idem: true })(req(), ctx)
    await route({ fn: 'fn' })(req({ headers: { 'Idempotency-Key': 'k1' } }), ctx)
    expect(rpc.mock.calls.map((c) => c[1])).toStrictEqual([{ p_idem: 'k1', p_uid: 'u1' }, { p_idem: null, p_uid: 'u1' }, { p_uid: 'u1' }])
  })

  it('retry_after ISO → Retry-After en secondes, 1 pour une date passée', async () => {
    signedIn()
    const at = (ms: number) => JSON.stringify({ status: 429, retry_after: new Date(Date.now() + ms).toISOString(), error: 'm', message: 'm' })
    pgError({ code: 'P0001', details: at(30_000) })
    const s = Number((await route({ fn: 'fn' })(req(), ctx)).headers.get('Retry-After'))
    expect(s).toBeGreaterThanOrEqual(29)
    expect(s).toBeLessThanOrEqual(31)
    pgError({ code: 'P0001', details: at(-5_000) })
    expect((await route({ fn: 'fn' })(req(), ctx)).headers.get('Retry-After')).toBe('1')
  })

  it('pre renvoie une HttpError → réponse telle quelle, aucune RPC ; rien → RPC appelée', async () => {
    const body = { ok: false, code: 'human_check_failed', error: 'x' }
    const pre = vi.fn(async () => ({ status: 400, body, retryAfter: 5 }))
    const handler = route({ fn: 'fn', input: z.object({ token: z.string() }), pre })
    expect((await handler(req({ method: 'POST', body: '{"token":"t"}' }), ctx)).status).toBe(401)
    expect(pre).not.toHaveBeenCalled()
    signedIn()
    const res = await handler(req({ method: 'POST', body: '{"token":"t"}' }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toStrictEqual(body)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(pre).toHaveBeenCalledWith({ token: 't' }, expect.any(NextRequest))
    expect(rpc).not.toHaveBeenCalled()
    await route({ fn: 'fn', pre: async () => {} })(req(), ctx)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each([429, 503])('pre renvoie un %i sans retryAfter → Retry-After: 1 ; un 400 n\'en porte pas', async (status) => {
    signedIn()
    const res = await route({ fn: 'fn', pre: async () => fail(status, 'm') })(req(), ctx)
    expect(res.status).toBe(status)
    expect(res.headers.get('Retry-After')).toBe('1')
    expect((await route({ fn: 'fn', pre: async () => fail(400, 'm') })(req(), ctx)).headers.get('Retry-After')).toBeNull()
  })

  it('HEAD : entrée lue dans la query string comme GET', async () => {
    signedIn()
    const args = vi.fn(() => ({}))
    await route({ fn: 'fn', input: z.looseObject({}), args })(req({ method: 'HEAD', query: '?page=2' }), ctx)
    expect(args).toHaveBeenCalledWith({ page: '2' }, expect.anything())
  })

  it('log : segments dynamiques masqués', async () => {
    await route({ fn: 'fn', auth: false })(new NextRequest('http://localhost/api/profile/abc-1/collection'), { params: Promise.resolve({ id: 'abc-1' }) })
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).route).toBe('/api/profile/[id]/collection')
  })
})

describe('fail', () => {
  it('corps D§8.2 : code seulement s\'il est donné', () => {
    expect(fail(400, 'm', 'c')).toStrictEqual({ status: 400, body: { code: 'c', error: 'm', message: 'm' } })
    expect(fail(500, 'm')).toStrictEqual({ status: 500, body: { error: 'm', message: 'm' } })
  })
})

describe('toHttpError', () => {
  it('429 sans retry_after → Retry-After 1', () => {
    expect(toHttpError({ code: 'P0001', details: '{"status":429,"error":"m","message":"m"}' }).retryAfter).toBe(1)
  })
  it('statut hors 400–599 → 500', () => {
    expect(toHttpError({ code: 'P0001', details: '{"status":200,"error":"m","message":"m"}' }).status).toBe(500)
  })
})
