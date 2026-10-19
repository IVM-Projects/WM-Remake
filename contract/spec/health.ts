import assert from 'node:assert/strict'
import { z } from 'zod'
import type { RouteSpec } from '../../lib/contract.ts'

const Health = z.object({ ok: z.literal(true), db: z.literal('ok') }) // clés en plus permises (now…)

export const health: RouteSpec = {
  method: 'GET',
  path: '/api/health',
  source: 'D§12.3',
  confidence: 'ajouté',
  cases: [
    {
      name: '200 { ok: true, db: "ok" } (route() → passerelle → PostgREST → wm.health en service_role)',
      run: async ({ plain }) => {
        const res = await fetch(`${plain}/api/health`)
        assert.equal(res.status, 200)
        Health.parse(await res.json())
      },
    },
  ],
}
