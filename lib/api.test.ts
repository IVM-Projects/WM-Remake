import { afterEach, expect, test, vi } from 'vitest'
import { api, ApiError } from './api'

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
