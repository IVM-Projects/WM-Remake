import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidateTag = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag }))
// lib/route importe l'admin, qui importe server-only.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))

const { POST } = await import('./route')

const post = (secret?: string) => POST(new Request('http://localhost/api/cron/revalidate', {
  method: 'POST', headers: secret === undefined ? {} : { 'x-cron-secret': secret },
}))
const DENIED = { code: 'cron_unauthorized', error: 'Secret de tâche planifiée invalide.', message: 'Secret de tâche planifiée invalide.' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('CRON_SECRET', 'bon-secret')
})

describe('POST /api/cron/revalidate', () => {
  it.each([undefined, ''])('CRON_SECRET %j → 503 cron_disabled, rien revalidé', async (value) => {
    vi.stubEnv('CRON_SECRET', value)
    const res = await post('bon-secret')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'cron_disabled', error: 'Tâche planifiée non configurée.', message: 'Tâche planifiée non configurée.' })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it.each([['faux', 'mauvais-sec'], ['de longueur différente', 'bon-secret-et-plus'], ['absent', undefined]])(
    'secret %s → 401 cron_unauthorized, rien revalidé', async (_, secret) => {
      const res = await post(secret)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual(DENIED)
      expect(revalidateTag).not.toHaveBeenCalled()
    })

  it('bon secret → 200 { revalidated: true }, revalidateTag("catalog", "max") une fois', async () => {
    const res = await post('bon-secret')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revalidated: true })
    expect(revalidateTag.mock.calls).toStrictEqual([['catalog', 'max']])
  })
})
