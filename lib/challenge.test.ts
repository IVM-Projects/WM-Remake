import { afterEach, expect, test, vi } from 'vitest'
import { toast } from '@/components/ui/toast'
import { ApiError, unsure } from './api'
import { afterChallenge, challengeFriend } from './challenge'

// toast écrit dans le DOM : remplacé par un espion (aucun DOM ici).
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// Réponses servies dans l'ordre, une par appel de fetch.
function stubFetch(...replies: (() => Promise<Response>)[]) {
  const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(() => replies.shift()!())
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const keyOf = (init: RequestInit) => new Headers(init.headers).get('Idempotency-Key')

test('201 { battle: { id }, id } → { id, existing: false } ; POST /api/battles avec le fuseau et une Idempotency-Key', async () => {
  const fetch = stubFetch(async () => Response.json({ battle: { id: 'b1' }, id: 'b1' }, { status: 201 }))
  expect(await challengeFriend(new Map(), 'u2')).toEqual({ id: 'b1', existing: false })
  const [path, init] = fetch.mock.calls[0]
  expect([path, init.method, init.body]).toEqual(['/api/battles', 'POST', JSON.stringify({ opponent_id: 'u2' })])
  expect(new Headers(init.headers).get('x-wiki-calendar-tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  expect(keyOf(init)).toMatch(/^[0-9a-f-]{36}$/)
})

test('409 avec battle_id → la bataille déjà ouverte, { id, existing: true }, sans lever', async () => {
  const busy = 'Une bataille est déjà en cours avec ce joueur'
  stubFetch(async () => Response.json({ error: busy, message: busy, battle_id: 'b0' }, { status: 409 }))
  expect(await challengeFriend(new Map(), 'u2')).toEqual({ id: 'b0', existing: true })
})

test('429 → lève l\'ApiError 429, refus net (pas incertain)', async () => {
  const limit = 'Limite quotidienne de défis atteinte'
  stubFetch(async () => Response.json({ error: limit, message: limit, retry_after: '2026-10-31T00:00:00Z' }, { status: 429 }))
  const e = await challengeFriend(new Map(), 'u2').catch((err: unknown) => err)
  expect(e).toBeInstanceOf(ApiError)
  expect(e).toMatchObject({ status: 429, message: limit })
  expect(unsure(e)).toBe(false)
})

test('issue incertaine (réseau, 500) : les relances reprennent la même clé', async () => {
  const fetch = stubFetch(
    () => Promise.reject(new TypeError('Failed to fetch')),
    async () => new Response(null, { status: 500 }),
    async () => Response.json({ battle: { id: 'b1' }, id: 'b1' }, { status: 201 }),
  )
  const keys = new Map<string, string>()
  expect(unsure(await challengeFriend(keys, 'u2').catch((e: unknown) => e))).toBe(true)
  expect(unsure(await challengeFriend(keys, 'u2').catch((e: unknown) => e))).toBe(true)
  expect(await challengeFriend(keys, 'u2')).toEqual({ id: 'b1', existing: false })
  const [a, b, c] = fetch.mock.calls.map(([, init]) => keyOf(init))
  expect(b).toBe(a)
  expect(c).toBe(a)
})

test('201 au corps illisible : lève une Error incertaine, jamais { id: undefined } ; la relance reprend la même clé', async () => {
  const fetch = stubFetch(
    async () => new Response('x', { status: 201 }),
    async () => Response.json({ battle: { id: 'b1' }, id: 'b1' }, { status: 201 }),
  )
  const keys = new Map<string, string>()
  const e = await challengeFriend(keys, 'u2').catch((err: unknown) => err)
  expect(e).toBeInstanceOf(Error)
  expect(unsure(e)).toBe(true)
  expect(await challengeFriend(keys, 'u2')).toEqual({ id: 'b1', existing: false })
  expect(keyOf(fetch.mock.calls[1][1])).toBe(keyOf(fetch.mock.calls[0][1]))
})

test('afterChallenge, défi neuf, page affichée : router.push vers l\'arène, toast « Défi envoyé à … »', () => {
  const router = { push: vi.fn() }
  afterChallenge(router, { id: 'b1', existing: false }, 'Alice', true)
  expect(router.push.mock.calls).toEqual([['/battle/b1']])
  expect(vi.mocked(toast).mock.calls).toEqual([['Défi envoyé à Alice.']])
})

test('afterChallenge, bataille déjà ouverte, page quittée : aucun router.push, toast « Une bataille est déjà en cours avec … »', () => {
  const router = { push: vi.fn() }
  afterChallenge(router, { id: 'b0', existing: true }, 'Alice', false)
  expect(router.push).not.toHaveBeenCalled()
  expect(vi.mocked(toast).mock.calls).toEqual([['Une bataille est déjà en cours avec Alice.']])
})
