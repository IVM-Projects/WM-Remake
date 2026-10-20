import assert from 'node:assert/strict'
import type { RouteSpec } from '../../lib/contract.ts'
import { api, makeUser, psql } from '../users.ts'

export const wallet: RouteSpec = {
  method: 'GET',
  path: '/api/wikibidous',
  source: 'R§3.2',
  confidence: 'conf.',
  cases: [
    {
      name: '200 { balance } égal à wikibidous_balance en base',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { balance: 1234 })
        const res = await api(env, '/api/wikibidous', { uid })
        assert.equal(res.status, 200)
        const db = psql(env.backend.databaseUrl, `select wikibidous_balance from public.profiles where id = :'uid'`, { uid })
        assert.deepEqual(await res.json(), { balance: Number(db) })
        assert.equal(db, '1234')
      },
    },
  ],
}
