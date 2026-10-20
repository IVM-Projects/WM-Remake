import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyTurnstile } from '@/lib/turnstile'

const fetchMock = vi.fn()
const reply = (status: number, body: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('TURNSTILE_SECRET_KEY', 's3cret')
  vi.stubEnv('TURNSTILE_VERIFY_URL', 'http://verify.test/siteverify')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fetchMock.mockReset()
})

describe('verifyTurnstile', () => {
  it('sans secret → false, aucun appel', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '')
    expect(await verifyTurnstile('t', null)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('success: true → true ; formulaire secret, response, remoteip vers TURNSTILE_VERIFY_URL', async () => {
    reply(200, { success: true })
    expect(await verifyTurnstile('tok', '203.0.113.7')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://verify.test/siteverify')
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(Object.fromEntries(new URLSearchParams(init.body))).toStrictEqual({ secret: 's3cret', response: 'tok', remoteip: '203.0.113.7' })
  })

  it('ip null → pas de remoteip', async () => {
    reply(200, { success: true })
    await verifyTurnstile('tok', null)
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body).has('remoteip')).toBe(false)
  })

  it('sans TURNSTILE_VERIFY_URL → vérificateur Cloudflare', async () => {
    vi.stubEnv('TURNSTILE_VERIFY_URL', '')
    reply(200, { success: true })
    await verifyTurnstile('tok', null)
    expect(fetchMock.mock.calls[0][0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
  })

  it.each([
    ['success: false', () => reply(200, { success: false })],
    ['statut 500', () => reply(500, { success: true })],
    ['exception réseau', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ['corps illisible', () => fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))],
  ])('%s → false', async (_, arrange) => {
    arrange()
    expect(await verifyTurnstile('tok', null)).toBe(false)
  })
})
