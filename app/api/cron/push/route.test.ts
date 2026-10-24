import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fabrique exigée : le module d'origine charge server-only, qui lève ici ; lib/route importe l'admin, qui l'importe aussi.
vi.mock('@/lib/push', () => ({ drainPush: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))

const { drainPush } = await import('@/lib/push')
const { POST } = await import('./route')
const { INTERNAL } = await import('@/lib/route')

const post = (secret?: string) => POST(new Request('http://localhost/api/cron/push', {
  method: 'POST', headers: secret === undefined ? {} : { 'x-cron-secret': secret },
}))
const DISABLED = 'Notifications push non configurées.'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('CRON_SECRET', 'bon-secret')
})

describe('POST /api/cron/push', () => {
  it('CRON_SECRET absent → 503 cron_disabled, aucun drain', async () => {
    vi.stubEnv('CRON_SECRET', undefined)
    const res = await post('bon-secret')
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(await res.json()).toEqual({ code: 'cron_disabled', error: 'Tâche planifiée non configurée.', message: 'Tâche planifiée non configurée.' })
    expect(drainPush).not.toHaveBeenCalled()
  })

  it('mauvais secret → 401 cron_unauthorized, aucun drain', async () => {
    const res = await post('mauvais')
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('cron_unauthorized')
    expect(drainPush).not.toHaveBeenCalled()
  })

  it('drainPush → null (VAPID absentes) → 503 push_disabled (M4b-16), Retry-After (D§8.1)', async () => {
    vi.mocked(drainPush).mockResolvedValueOnce(null)
    const res = await post('bon-secret')
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(await res.json()).toEqual({ code: 'push_disabled', error: DISABLED, message: DISABLED })
  })

  it('{ sent: 1, gone: 0, failed: 0 } → 200, ce corps', async () => {
    vi.mocked(drainPush).mockResolvedValueOnce({ sent: 1, gone: 0, failed: 0 })
    const res = await post('bon-secret')
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ sent: 1, gone: 0, failed: 0 })
  })

  it('drainPush lève → 500 INTERNAL, sans détail ; journalisé comme route() ({ push: "drain_failed" }, sans le message)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(drainPush).mockRejectedValueOnce(new Error('relation secrète'))
    const res = await post('bon-secret')
    expect(res.status).toBe(500)
    expect(res.headers.get('retry-after')).toBeNull()
    expect(await res.json()).toStrictEqual({ error: INTERNAL, message: INTERNAL })
    expect(log.mock.calls).toStrictEqual([[JSON.stringify({ push: 'drain_failed' })]])
    log.mockRestore()
  })
})
