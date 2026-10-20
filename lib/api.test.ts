import { afterEach, expect, test, vi } from 'vitest'
import { api, ApiError, apiOnce, idemKey, unsure, userMessage } from './api'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(async () => Response.json(body, { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

test('idem ajoute une Idempotency-Key neuve à chaque appel, et le corps JSON est rendu', async () => {
  const fetch = stubFetch(200, { balance: 12 })
  expect(await api<{ balance: number }>('/api/user-cards/u1/discard', { method: 'POST', idem: true })).toEqual({ balance: 12 })
  await api('/api/user-cards/u1/discard', { method: 'POST', idem: true })
  const keys = fetch.mock.calls.map(([, init]) => new Headers(init.headers).get('Idempotency-Key'))
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(keys[1]).not.toBe(keys[0])
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('idem')
})

test('sans idem, pas de clé ; un corps texte part en JSON', async () => {
  const fetch = stubFetch(200, {})
  await api('/api/settings/preferences', { method: 'POST', body: JSON.stringify({ sounds: false }) })
  const headers = new Headers(fetch.mock.calls[0][1].headers)
  expect(headers.has('Idempotency-Key')).toBe(false)
  expect(headers.get('Content-Type')).toBe('application/json')
})

test('une erreur lève ApiError { status, body } avec le message du serveur', async () => {
  stubFetch(403, { code: '42501', error: 'Vous ne possédez pas cette carte', message: 'Vous ne possédez pas cette carte' })
  const err = await api('/api/user-cards/u1/discard', { method: 'POST' }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err).toMatchObject({ status: 403, body: { code: '42501' }, message: 'Vous ne possédez pas cette carte' })
})

test('hors contexte sécurisé (pas de randomUUID), la clé vient de getRandomValues', () => {
  const real = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) })
  const [a, b] = [idemKey(), idemKey()]
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  expect(b).not.toBe(a)
})

test('idem en chaîne : cette clé-là est envoyée telle quelle', async () => {
  const fetch = stubFetch(200, {})
  await api('/api/packs/open', { method: 'POST', idem: 'cle-1' })
  expect(new Headers(fetch.mock.calls[0][1].headers).get('Idempotency-Key')).toBe('cle-1')
})

test('userMessage : le message français de nos routes sous 500, le repli sinon', () => {
  const ours = new ApiError(403, { code: '42501', error: 'Vous ne possédez pas cette carte', message: 'Vous ne possédez pas cette carte' })
  expect(userMessage(ours, 'repli')).toBe('Vous ne possédez pas cette carte')
  // 5xx (nos routes comprises), corps non JSON (page de la plateforme), réseau : jamais « Erreur 504 » ni un texte anglais.
  expect(userMessage(new ApiError(500, { error: 'Erreur interne, réessaie dans un instant.' }), 'repli')).toBe('repli')
  expect(userMessage(new ApiError(504, null), 'repli')).toBe('repli')
  expect(userMessage(new ApiError(413, null), 'repli')).toBe('repli')
  expect(userMessage(new ApiError(404, {}), 'repli')).toBe('repli')
  expect(userMessage(new TypeError('Failed to fetch'), 'repli')).toBe('repli')
  expect(unsure(new TypeError('Failed to fetch'))).toBe(true)
  expect(unsure(new ApiError(502, null))).toBe(true)
  expect(unsure(ours)).toBe(false)
})

test('apiOnce : même clé après un échec sans verdict (réseau, 5xx), clé neuve après un 2xx ou un 4xx', async () => {
  const replies: (() => Promise<Response>)[] = [
    () => Promise.reject(new TypeError('Failed to fetch')),
    async () => new Response('An error occurred', { status: 504, headers: { 'Content-Type': 'text/plain' } }),
    async () => Response.json({ balance: 3 }),
    async () => Response.json({ error: 'Vous ne possédez pas cette carte' }, { status: 403 }),
    async () => Response.json({ balance: 4 }),
  ]
  const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(() => replies.shift()!())
  vi.stubGlobal('fetch', fetch)
  const keys = new Map<string, string>()
  const call = () => apiOnce<{ balance: number }>(keys, 'u1', '/api/user-cards/u1/discard', { method: 'POST' }).catch((e: unknown) => e)
  expect(await call()).toBeInstanceOf(TypeError)
  expect(await call()).toMatchObject({ status: 504 })
  expect(await call()).toEqual({ balance: 3 })
  expect(keys.size).toBe(0)
  expect(await call()).toMatchObject({ status: 403 })
  expect(keys.size).toBe(0)
  await call()
  const sent = fetch.mock.calls.map(([, init]) => new Headers(init.headers).get('Idempotency-Key'))
  expect(sent[1]).toBe(sent[0])
  expect(sent[2]).toBe(sent[0])
  expect(sent[3]).not.toBe(sent[0])
  expect(sent[4]).not.toBe(sent[3])
})
