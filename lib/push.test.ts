import { createECDH, randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import webpush from 'web-push'

// server-only lève hors de la condition react-server, et lib/push.ts l'importe lui-même.
vi.mock('server-only', () => ({}))
const rpc = vi.fn()
const schema = vi.fn(() => ({ rpc }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ schema }) }))

const { drainPush, pushPayload } = await import('@/lib/push')
const { vapidConfig } = await import('@/lib/vapid')
const { brand } = await import('@/lib/brand')

const VAPID = webpush.generateVAPIDKeys()
const SUBJECT = 'mailto:push@example.invalid'
const ua = createECDH('prime256v1')
ua.generateKeys()

type Row = { subscription_id: string; endpoint: string; p256dh: string; auth: string; notification_id: string; type: string; data: Record<string, unknown> }
const row = (i: number, over: Partial<Row> = {}): Row => ({
  subscription_id: `s-${i}`, endpoint: `https://push.example/${i}`, p256dh: ua.getPublicKey('base64url'),
  auth: randomBytes(16).toString('base64url'), notification_id: `n-${i}`, type: 'friend_request', data: { user_id: 'u-1', username: 'Alice' }, ...over,
})
const claim = (rows: Row[]) => rpc.mockImplementation(async (fn: string) => ({ data: fn === 'push_claim' ? rows : 1, error: null }))
const fetchMock = vi.fn<typeof fetch>()
// Statut tiré du dernier segment de l'endpoint.
const byIndex = (status: (i: number) => number) =>
  fetchMock.mockImplementation(async (url) => new Response(null, { status: status(Number(String(url).split('/').pop())) }))
const goneCalls = () => rpc.mock.calls.filter(([fn]) => fn === 'push_gone')

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('VAPID_PRIVATE', VAPID.privateKey)
  vi.stubEnv('VAPID_SUBJECT', SUBJECT)
})

describe('vapidConfig et drainPush, push coupé (M4b-16)', () => {
  it.each([
    ['sans VAPID_SUBJECT', VAPID.privateKey, undefined],
    ['VAPID_PRIVATE valide suivie de \\n', `${VAPID.privateKey}\n`, SUBJECT],
    ['VAPID_SUBJECT = http://x', VAPID.privateKey, 'http://x'],
    ['VAPID_PRIVATE absente', undefined, SUBJECT],
    ['VAPID_SUBJECT illisible par new URL', VAPID.privateKey, 'pas une url'],
    ['clé nulle, que la dérivation refuse', 'A'.repeat(43), SUBJECT],
  ])('%s → null, aucune RPC', async (_, priv, subject) => {
    vi.stubEnv('VAPID_PRIVATE', priv)
    vi.stubEnv('VAPID_SUBJECT', subject)
    expect(vapidConfig()).toBeNull()
    expect(await drainPush()).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('publicKey dérivée de VAPID_PRIVATE (M4b-14) ; VAPID_PUBLIC jamais lue, même posée', () => {
    vi.stubEnv('VAPID_PUBLIC', webpush.generateVAPIDKeys().publicKey)
    expect(vapidConfig()).toStrictEqual({ subject: SUBJECT, publicKey: VAPID.publicKey, privateKey: VAPID.privateKey })
  })
})

describe('drainPush', () => {
  it('120 lignes → push_claim(500) une fois, fetch 120 fois, jamais plus de 50 en vol', async () => {
    claim(Array.from({ length: 120 }, (_, i) => row(i)))
    let inFlight = 0
    let peak = 0
    fetchMock.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return new Response(null, { status: 201 })
    })
    expect(await drainPush()).toStrictEqual({ sent: 120, gone: 0, failed: 0 })
    expect(schema).toHaveBeenCalledWith('wm')
    expect(rpc.mock.calls).toStrictEqual([['push_claim', { p_limit: 500 }]])
    expect(fetchMock).toHaveBeenCalledTimes(120)
    expect(peak).toBe(50)
  })

  it('201, 404, 410, 500 et un AbortError → { sent: 1, gone: 2, failed: 2 }, un push_gone sur les deux ids, une ligne de journal', async () => {
    claim([0, 1, 2, 3, 4].map((i) => row(i)))
    const statuses = [201, 404, 410, 500]
    fetchMock.mockImplementation(async (url) => {
      const i = Number(String(url).split('/').pop())
      if (i === 4) throw new DOMException('délai dépassé', 'AbortError')
      return new Response(null, { status: statuses[i] })
    })
    expect(await drainPush()).toStrictEqual({ sent: 1, gone: 2, failed: 2 })
    expect(goneCalls()).toStrictEqual([['push_gone', { p_subscription_ids: ['s-1', 's-2'] }]])
    // Sans endpoint ni uid (aucune PII dans les logs).
    expect(vi.mocked(console.log).mock.calls).toStrictEqual([['{"push":{"claimed":5,"sent":1,"gone":2,"failed":2}}']])
  })

  it('deux lignes du même abonnement en 410 → push_gone une fois, l\'id une seule fois', async () => {
    claim([row(0), row(1, { subscription_id: 's-0' })])
    byIndex(() => 410)
    expect(await drainPush()).toStrictEqual({ sent: 0, gone: 2, failed: 0 })
    expect(goneCalls()).toStrictEqual([['push_gone', { p_subscription_ids: ['s-0'] }]])
  })

  it('p256dh hors de la courbe (conforme à l\'expression) : seule sa ligne échoue → { sent: 2, gone: 0, failed: 1 }, fetch 2 fois', async () => {
    claim([row(0), row(1, { p256dh: `B${'A'.repeat(86)}` }), row(2)])
    byIndex(() => 201)
    expect(await drainPush()).toStrictEqual({ sent: 2, gone: 0, failed: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(goneCalls()).toStrictEqual([])
  })

  it('chaque fetch : POST vers l\'endpoint, redirect error, corps Uint8Array, aes128gcm, TTL 86400, vapid t=, sans Content-Length, un signal', async () => {
    claim([row(0), row(1)])
    byIndex(() => 201)
    await drainPush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [i, [url, init]] of fetchMock.mock.calls.entries()) {
      expect(url).toBe(`https://push.example/${i}`)
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
      // Une copie des seuls octets chiffrés, pas le Buffer (B8).
      expect(init?.body).toBeInstanceOf(Uint8Array)
      expect(Buffer.isBuffer(init?.body)).toBe(false)
      const headers = init?.headers as Record<string, string>
      expect(headers['Content-Encoding']).toBe('aes128gcm')
      expect(headers.TTL).toBe('86400')
      expect(headers.Authorization).toMatch(/^vapid t=/)
      expect(headers).not.toHaveProperty('Content-Length')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })
})

describe('pushPayload (B8)', () => {
  it('chat_message → « <u> t\'a écrit », lien du fil, tag dm:<id> ; trade_received → tag = id de la notification', () => {
    expect(pushPayload({ notification_id: 'n-1', type: 'chat_message', data: { user_id: 'u-1', username: 'Alice' } }))
      .toStrictEqual({ title: brand.name, body: 'Alice t\'a écrit', url: '/dms?with=u-1', tag: 'dm:u-1' })
    expect(pushPayload({ notification_id: 'n-2', type: 'trade_received', data: { trade_id: 't-1', user_id: 'u-1', username: 'Alice' } }))
      .toStrictEqual({ title: brand.name, body: 'Alice te propose un échange', url: '/trades/t-1', tag: 'n-2' })
  })
})
