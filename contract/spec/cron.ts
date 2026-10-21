import assert from 'node:assert/strict'
import type { RouteSpec } from '../../lib/contract.ts'
import { CRON_SECRET } from '../harness.ts'
import { failed } from '../users.ts'

const revalidate = (base: string, secret?: string) =>
  fetch(`${base}/api/cron/revalidate`, { method: 'POST', headers: secret === undefined ? {} : { 'x-cron-secret': secret } })

async function denied(res: Response): Promise<void> {
  assert.equal((await failed(res, 401, 'cron_unauthorized')).error, 'Secret de tâche planifiée invalide.')
}

// Revalidation du catalogue après un chargement (M2-15) ; 503 sans CRON_SECRET couvert par le test unitaire.
export const cron: RouteSpec = {
  method: 'POST',
  path: '/api/cron/revalidate',
  source: 'D§5.3',
  confidence: 'ajouté',
  cases: [
    { name: 'sans x-cron-secret → 401 cron_unauthorized', run: async ({ plain }) => denied(await revalidate(plain)) },
    { name: 'mauvais secret → 401 cron_unauthorized', run: async ({ plain }) => denied(await revalidate(plain, `${CRON_SECRET}x`)) },
    {
      name: 'bon secret → 200 { revalidated: true }',
      run: async ({ plain }) => {
        const res = await revalidate(plain, CRON_SECRET)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), { revalidated: true })
      },
    },
    {
      name: 'serveur à porte, sans cookie de porte, bon secret → 200 (la porte laisse passer /api/cron/*)',
      run: async ({ gated }) => assert.equal((await revalidate(gated, CRON_SECRET)).status, 200),
    },
  ],
}
