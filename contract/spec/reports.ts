import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, idem, makeUser, noSession, ok, psql, refused, send } from '../users.ts'

// Signalement de wm.report_get (R§3.7) ; strict : une clé en plus ferait échouer le cas au lieu de disparaître avant le deepEqual.
const Report = z.strictObject({
  report: z.strictObject({ reason: z.enum(['cheating', 'inappropriate_content', 'spam']), details: z.string().nullable() }).nullable(),
})

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const player = (env: ContractEnv) => makeUser(db(env)).uid
const get = (env: ContractEnv, uid: string, reportedUserId: string) => api(env, `/api/reports?reportedUserId=${reportedUserId}`, { uid })
const post = (env: ContractEnv, uid: string, body: unknown, headers?: Record<string, string>) => send(env, 'POST', '/api/reports', uid, body, headers)
// Lignes du couple (auteur, cible), en raison:détails.
const rows = (env: ContractEnv, me: string, target: string) => sql(env, `select coalesce(string_agg(reason || ':' || coalesce(details, '<null>'), ','), '')
from public.reports where reporter_id = :'me' and reported_user_id = :'target'`, { me, target })

export const reportGet: RouteSpec = {
  method: 'GET',
  path: '/api/reports',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('GET', `/api/reports?reportedUserId=${randomUUID()}`),
    {
      name: 'reportedUserId=abc → 400 « UUID invalide » (zod)',
      run: async (env) => refused(await get(env, player(env), 'abc'), 400, 'UUID invalide', 'invalid_request'),
    },
    {
      name: 'aucun signalement → { report: null } ; le sien (psql) → { report: { reason, details } }, pas celui d\'un autre auteur',
      run: async (env) => {
        const [me, other, target] = [player(env), player(env), player(env)]
        assert.deepEqual(await ok(await get(env, me, target), Report), { report: null })
        sql(env, `insert into public.reports (reporter_id, reported_user_id, reason, details) values (:'other', :'target', 'spam', 'x')`, { other, target })
        assert.deepEqual(await ok(await get(env, me, target), Report), { report: null })
        sql(env, `insert into public.reports (reporter_id, reported_user_id, reason) values (:'me', :'target', 'cheating')`, { me, target })
        assert.deepEqual(await ok(await get(env, me, target), Report), { report: { reason: 'cheating', details: null } })
      },
    },
  ],
}

export const reportUpsert: RouteSpec = {
  method: 'POST',
  path: '/api/reports',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('POST', '/api/reports'),
    {
      name: '→ { report: { reason: spam, details: x } } (M4b-8) ; modifié ensuite → une seule ligne, la nouvelle',
      run: async (env) => {
        const [me, target] = [player(env), player(env)]
        assert.deepEqual(await ok(await post(env, me, { reportedUserId: target, reason: 'spam', details: 'x' }), Report),
          { report: { reason: 'spam', details: 'x' } })
        assert.deepEqual(await ok(await post(env, me, { reportedUserId: target, reason: 'cheating' }), Report),
          { report: { reason: 'cheating', details: null } })
        assert.equal(rows(env, me, target), 'cheating:<null>')
      },
    },
    {
      name: 'soi-même → 400 ; reason abuse → 400 ; détails de 501 → 400 ; id inconnu → 404 ; aucune ligne',
      run: async (env) => {
        const [me, target] = [player(env), player(env)]
        await refused(await post(env, me, { reportedUserId: me, reason: 'spam' }), 400, 'Tu ne peux pas te signaler toi-même', 'invalid_request')
        await refused(await post(env, me, { reportedUserId: target, reason: 'abuse' }), 400, 'Motif de signalement inconnu', 'invalid_request')
        await refused(await post(env, me, { reportedUserId: target, reason: 'spam', details: 'a'.repeat(501) }), 400,
          'Les détails font au plus 500 caractères', 'invalid_request')
        await refused(await post(env, me, { reportedUserId: randomUUID(), reason: 'spam' }), 404, 'Joueur introuvable')
        assert.equal(sql(env, `select count(*) from public.reports where reporter_id = :'me'`, { me }), '0')
      },
    },
    {
      name: 'même Idempotency-Key deux fois, la seconde avec un autre motif → corps identiques, le premier signalement gardé',
      run: async (env) => {
        const [me, target] = [player(env), player(env)]
        const key = idem()
        const first = await ok(await post(env, me, { reportedUserId: target, reason: 'spam', details: 'x' }, key), Report)
        assert.deepEqual(await ok(await post(env, me, { reportedUserId: target, reason: 'cheating' }, key), Report), first)
        assert.equal(rows(env, me, target), 'spam:x')
      },
    },
  ],
}

export const reports: RouteSpec[] = [reportGet, reportUpsert]
