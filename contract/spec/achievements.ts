import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { failed, giveCards, idem, makeUser, noSession, ok, psql, refused, send } from '../users.ts'

const Check = z.strictObject({ ok: z.literal(true), unlocked: z.int().min(0) })
const Ok = z.strictObject({ ok: z.literal(true) })

const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(env.backend.databaseUrl, query, vars)
const post = (env: ContractEnv, path: string, uid: string, body: unknown, headers?: Record<string, string>) =>
  send(env, 'POST', `/api/achievements/${path}`, uid, body, headers)
// Succès "Première commune" (10 WB) et "Ultra rare" (jamais atteint avec des C), par leur code d'origine.
const FIRST_C = `md5('wm-ach:first_c')::uuid`
const FIRST_UR = `md5('wm-ach:first_ur')::uuid`

export const achievements: RouteSpec[] = [
  {
    method: 'POST',
    path: '/api/achievements/check',
    source: 'R§3.8',
    confidence: 'prob.',
    cases: [
      noSession('POST', '/api/achievements/check'),
      {
        name: '{} → 400 « Événement inconnu » ; { event: achievements_sync } → { ok, unlocked } ; aussitôt de nouveau (autre clé) → 429 exact, Retry-After de 1 à 300',
        run: async (env) => {
          const me = makeUser(env.backend.databaseUrl)
          giveCards(env.backend.databaseUrl, me.uid, 'C', 3)
          await refused(await post(env, 'check', me.uid, {}), 400, 'Événement inconnu', 'invalid_request')
          const first = await ok(await post(env, 'check', me.uid, { event: 'achievements_sync' }), Check)
          assert.ok(first.unlocked >= 1)
          const res = await post(env, 'check', me.uid, { event: 'achievements_sync' }, idem())
          const body = await failed(res, 429)
          assert.deepEqual(Object.keys(body).toSorted(), ['error', 'message', 'retry_after'])
          const after = res.headers.get('retry-after') ?? ''
          assert.match(after, /^[1-9][0-9]*$/)
          assert.ok(Number(after) >= 1 && Number(after) <= 300, `Retry-After: ${after}`)
        },
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/achievements/claim',
    source: 'R§3.8',
    confidence: 'prob.',
    cases: [
      noSession('POST', '/api/achievements/claim'),
      {
        name: 'Review Focus, réclamation rejouée par HTTP : { ok } ; même clé → corps identique ; autre clé → 409 exact ; une seule ligne ach:<id>, solde + récompense ; '
          + 'verrouillé → 409 exact ; uuid inconnu → 404 exact ; check_invariants() = []',
        run: async (env) => {
          const me = makeUser(env.backend.databaseUrl)
          giveCards(env.backend.databaseUrl, me.uid, 'C', 50)
          await ok(await post(env, 'check', me.uid, { event: 'achievements_sync' }), Check)
          const id = sql(env, `select ${FIRST_C}`)
          const reward = sql(env, `select wikibidous_reward from public.achievements where id = ${FIRST_C}`)
          const before = sql(env, `select wikibidous_balance from public.profiles where id = :'u'`, { u: me.uid })
          const key = idem()
          assert.deepEqual(await ok(await post(env, 'claim', me.uid, { achievement_id: id }, key), Ok), { ok: true })
          assert.deepEqual(await ok(await post(env, 'claim', me.uid, { achievement_id: id }, key), Ok), { ok: true })
          await refused(await post(env, 'claim', me.uid, { achievement_id: id }, idem()), 409, 'Ce succès a déjà été réclamé')
          assert.equal(sql(env, `select count(*) from wm.wb_ledger where user_id = :'u' and ref = 'ach:' || :'id'`, { u: me.uid, id }), '1')
          assert.equal(Number(sql(env, `select wikibidous_balance from public.profiles where id = :'u'`, { u: me.uid })), Number(before) + Number(reward))
          await refused(await post(env, 'claim', me.uid, { achievement_id: sql(env, `select ${FIRST_UR}`) }), 409, 'Ce succès n\'est pas encore débloqué')
          await refused(await post(env, 'claim', me.uid, { achievement_id: '00000000-0000-4000-8000-000000000000' }), 404, 'Succès introuvable')
          await refused(await post(env, 'claim', me.uid, { achievement_id: 'x' }), 400, 'UUID invalide', 'invalid_request')
          assert.equal(sql(env, `select wm.check_invariants()`), '[]')
        },
      },
    ],
  },
]
