import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, failed, idem, Iso, makeUser, noSession, ok, psql, send } from '../users.ts'
import { rest } from './rest.ts'

// Ligne de wm.notifications_list (R§3.7) ; data tel qu'écrit par wm.notify_* (M3-8, M4-12). Stricts : les cinq clés sont tout le contrat,
// et une clé en plus, dans une ligne ou dans l'enveloppe, ferait échouer le cas au lieu de disparaître avant le deepEqual.
const Notification = z.strictObject({ id: z.uuid(), type: z.string(), data: z.record(z.string(), z.unknown()), read: z.boolean(), created_at: Iso })
const List = z.strictObject({ notifications: z.array(Notification) })
const Read = z.strictObject({ ok: z.literal(true), updated: z.int() })

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const player = (env: ContractEnv) => makeUser(db(env)).uid
// n non-lues neuves de `uid` ; renvoie leurs ids.
const unread = (env: ContractEnv, uid: string, n: number) => sql(env, `insert into public.notifications (user_id, type, data)
select :'uid', 'friend_request', '{}' from generate_series(1, :'n'::int) returning id`, { uid, n: String(n) }).split('\n')
const isRead = (env: ContractEnv, id: string) => sql(env, `select read from public.notifications where id = :'id'`, { id })
const mark = (env: ContractEnv, uid: string, body: unknown, headers?: Record<string, string>) =>
  send(env, 'PATCH', '/api/notifications', uid, body, headers)

export const notificationsList: RouteSpec = {
  method: 'GET',
  path: '/api/notifications',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/notifications'),
    {
      name: '55 lignes à une seconde d\'écart (un auction_outbid du M3) et 3 d\'un autre → les 50 plus récentes, created_at desc, au schéma exact',
      run: async (env) => {
        const [me, other] = [player(env), player(env)]
        // data de wm.notification_data (1600_wm_market_core.sql) pour une surenchère.
        const outbid = { auction_id: randomUUID(), card_id: randomUUID(), card_title: 'Chat', wikipedia_title: 'Chat', amount: 120 }
        // Insérées de la plus ancienne à la plus récente : l'ordre d'insertion ne dit rien de l'ordre rendu.
        const ids = sql(env, `with ins as (insert into public.notifications (user_id, type, data, created_at)
select :'me', case when i = 30 then 'auction_outbid' else 'trade_received' end,
  case when i = 30 then :'outbid'::jsonb else jsonb_build_object('trade_id', gen_random_uuid(), 'user_id', :'me', 'username', 'x') end,
  now() - make_interval(secs => 55 - i)
from generate_series(1, 55) i order by i returning id, created_at)
select string_agg(id::text, ',' order by created_at desc) from ins`, { me, outbid: JSON.stringify(outbid) }).split(',')
        unread(env, other, 3)
        const { notifications } = await ok(await api(env, '/api/notifications', { uid: me }), List)
        assert.deepEqual(notifications.map((n) => n.id), ids.slice(0, 50))
        assert.ok(notifications.every((n) => !n.read))
        assert.deepEqual(notifications.filter((n) => n.type === 'auction_outbid').map((n) => n.data), [outbid])
      },
    },
  ],
}

export const notificationsRead: RouteSpec = {
  method: 'PATCH',
  path: '/api/notifications',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('PATCH', '/api/notifications'),
    {
      name: '{ids: [x, y]} → updated 2 ; l\'id d\'un autre → updated 0, la sienne reste non lue ; {} → le reste ; abc ou 101 ids → 400 (P10)',
      run: async (env) => {
        const [me, other] = [player(env), player(env)]
        const [x, y] = unread(env, me, 4)
        const [theirs] = unread(env, other, 1)
        assert.deepEqual(await ok(await mark(env, me, { ids: [x, y] }), Read), { ok: true, updated: 2 })
        assert.equal(isRead(env, x), 't')
        assert.deepEqual(await ok(await mark(env, me, { ids: [theirs] }), Read), { ok: true, updated: 0 })
        assert.equal(isRead(env, theirs), 'f')
        assert.deepEqual(await ok(await mark(env, me, {}), Read), { ok: true, updated: 2 })
        await failed(await mark(env, me, { ids: ['abc'] }), 400, 'invalid_request')
        await failed(await mark(env, me, { ids: Array.from({ length: 101 }, () => randomUUID()) }), 400, 'invalid_request')
      },
    },
    {
      name: 'trois non-lues, {} avec la même Idempotency-Key deux fois → updated 3 deux fois (sans clé, le second rendrait 0)',
      run: async (env) => {
        const me = player(env)
        unread(env, me, 3)
        const key = idem()
        for (let i = 0; i < 2; i++) assert.deepEqual(await ok(await mark(env, me, {}, key), Read), { ok: true, updated: 3 })
      },
    },
    {
      name: 'lecture de la cloche (M4-13) : rest/v1/notifications?select=id&read=eq.false&limit=10 → 10 de mes 12 non-lues ; un autre joueur → []',
      run: async (env) => {
        const [me, other] = [player(env), player(env)]
        const mine = unread(env, me, 12)
        const bell = 'notifications?select=id&read=eq.false&limit=10'
        const rows = z.array(z.object({ id: z.uuid() })).parse(await (await rest(env, bell, { uid: me })).json())
        assert.equal(rows.length, 10)
        assert.ok(rows.every((r) => mine.includes(r.id)))
        const res = await rest(env, bell, { uid: other })
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), [])
      },
    },
  ],
}

export const notifications: RouteSpec[] = [notificationsList, notificationsRead]
