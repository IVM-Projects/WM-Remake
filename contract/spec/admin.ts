import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, authCookie, created, failed, idem, Iso, makeUser, noSession, ok, psql, refused, send } from '../users.ts'

// Formes strictes (comme guilds.ts) : une clé en plus ferait échouer le cas au lieu de disparaître avant le deepEqual.
const Role = z.enum(['admin', 'moderator'])
const Sanction = z.strictObject({
  id: z.int().positive(), user_id: z.uuid(), kind: z.enum(['warning', 'restriction', 'suspension', 'ban']), reason: z.string().nullable(),
  starts_at: Iso, ends_at: Iso.nullable(), revoked_at: Iso.nullable(), created_by: z.uuid().nullable(), created_at: Iso,
  active: z.boolean(), created_by_username: z.string().nullable(),
})
const AuthState = z.strictObject({ user_id: z.uuid(), deleted: z.boolean(), forever: z.boolean(), ban_until: Iso.nullable() })
const Sanctioned = z.strictObject({ sanction: Sanction, auth: AuthState, auth_synced: z.boolean() })
const Synced = z.strictObject({ auth: AuthState, auth_synced: z.boolean() })
const Me = z.strictObject({ role: Role.nullable() })
const count = z.int().min(0)
const Dashboard = z.strictObject({
  open_reports: count, image_reports: count, auto_hidden_cards: count, active_sanctions: count, removed_cards: count, auth_pending: count,
  health: z.object({}).loose(),
})
const AuditRow = z.strictObject({
  id: z.int().positive(), staff_id: z.uuid().nullable(), staff_username: z.string().nullable(), action: z.string(), target_type: z.string(),
  target_id: z.string(), reason: z.string(), payload: z.record(z.string(), z.unknown()), created_at: Iso,
})
const Audit = z.strictObject({ actions: z.array(AuditRow), hasMore: z.boolean() })
const UserRow = z.strictObject({ id: z.uuid(), username: z.string(), created_at: Iso, deleted: z.boolean() })
const Search = z.strictObject({ users: z.array(UserRow) })
const UserDetail = z.strictObject({
  user: z.strictObject({
    id: z.uuid(), username: z.string(), created_at: Iso, last_seen_at: Iso.nullable(), is_pro: z.boolean(), is_vip: z.boolean(),
    balance: z.int(), is_public: z.boolean(), deleted_at: Iso.nullable(), auth_pending: z.boolean(),
  }),
  staff_role: Role.nullable(), sanctions: z.array(Sanction), reports_received: count, reports_filed: count,
  guild: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
})
const Ok = z.strictObject({ ok: z.literal(true) })

const STAFF_ONLY = 'Accès réservé à l\'équipe de modération'
const ADMIN_ONLY = 'Action réservée aux administrateurs'
const BLOCKED = 'Ton compte est temporairement restreint.'
const REASON = 'Triche avérée'

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const player = (env: ContractEnv) => makeUser(db(env), { humanVerified: true })
// Un membre du staff neuf de ce rôle.
export function staffOf(env: ContractEnv, role: 'admin' | 'moderator'): { uid: string; username: string } {
  return makeUser(db(env), { staff: role })
}
const post = (env: ContractEnv, path: string, uid: string, body: unknown, headers: Record<string, string> = idem()) =>
  send(env, 'POST', `/api/admin${path}`, uid, body, headers)
const get = (env: ContractEnv, path: string, uid: string) => api(env, `/api/admin${path}`, { uid })
const sanction = (env: ContractEnv, staff: string, target: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  post(env, `/users/${target}/sanctions`, staff, { reason: REASON, ...body }, headers)
const bannedUntil = (env: ContractEnv, uid: string) => sql(env, `select coalesce(banned_until::text, '') from auth.users where id = :'u'`, { u: uid })
const restrict = (env: ContractEnv, uid: string) =>
  sql(env, `insert into wm.sanctions (user_id, kind, reason, ends_at) values (:'u', 'restriction', 'test', now() + interval '1 hour')`, { u: uid })
// Refus d'un compte sanctionné (wm.actor, wm.access_check, wm.staff_actor) : corps entier, échéance comprise si donnée.
async function blocked(res: Response, until?: string | null): Promise<void> {
  const body = await failed(res, 403)
  assert.deepEqual(Object.keys(body).sort(), ['activity_blocked_until', 'error', 'message'])
  assert.equal(body.error, BLOCKED)
  if (until !== undefined) assert.equal(body.activity_blocked_until, until)
}
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString()

const spec = (method: RouteSpec['method'], path: string, cases: RouteSpec['cases'], body?: unknown): RouteSpec => {
  const url = `/api/admin${path.replace('{userId}', randomUUID()).replace('{sanctionId}', '1')}`
  const asPlayer = {
    name: 'un joueur → 403 « Accès réservé à l\'équipe de modération »',
    run: async (env: ContractEnv) => refused(await send(env, method, url, player(env).uid, body, idem()), 403, STAFF_ONLY, 'FORBIDDEN'),
  }
  return {
    method, path: `/api/admin${path.split('?')[0]}`, source: 'D§7.12', confidence: 'ajouté',
    cases: [noSession(method, url), ...(path === '/me' ? [] : [asPlayer]), ...cases],
  }
}

export const admin: RouteSpec[] = [
  spec('GET', '/me', [
    {
      name: 'joueur → {role: null} ; admin et modérateur → leur rôle',
      run: async (env) => {
        assert.deepEqual(await ok(await get(env, '/me', player(env).uid), Me), { role: null })
        assert.deepEqual(await ok(await get(env, '/me', staffOf(env, 'admin').uid), Me), { role: 'admin' })
        assert.deepEqual(await ok(await get(env, '/me', staffOf(env, 'moderator').uid), Me), { role: 'moderator' })
      },
    },
  ]),
  spec('GET', '/dashboard', [
    {
      name: 'modérateur → Dashboard strict, active_sanctions compte une sanction posée',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        const before = (await ok(await get(env, '/dashboard', mod.uid), Dashboard)).active_sanctions
        restrict(env, player(env).uid)
        assert.ok((await ok(await get(env, '/dashboard', mod.uid), Dashboard)).active_sanctions >= before + 1)
      },
    },
    {
      name: 'admin sous restriction active → 403 restreint sur le tableau de bord comme sur une sanction (G4)',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        restrict(env, boss.uid)
        await blocked(await get(env, '/dashboard', boss.uid))
        await blocked(await sanction(env, boss.uid, player(env).uid, { kind: 'warning' }))
        assert.equal(sql(env, `select count(*) from wm.staff_actions where staff_id = :'s'`, { s: boss.uid }), '0')
      },
    },
  ]),
  spec('GET', '/audit', [
    {
      name: 'actions du test, la plus récente d\'abord, formes strictes ; filtres cible et staff',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        const p = player(env)
        const s = await created(await sanction(env, boss.uid, p.uid, { kind: 'warning' }), Sanctioned)
        await ok(await post(env, `/users/${p.uid}/achievements-recheck`, boss.uid, { reason: 'Revoir les succès' }), Ok)
        const { actions, hasMore } = await ok(await get(env, `/audit?staff_id=${boss.uid}`, boss.uid), Audit)
        assert.equal(hasMore, false)
        assert.deepEqual(actions.map((a) => [a.action, a.target_type, a.target_id, a.reason, a.staff_username]),
          [['achievements_recheck', 'user', p.uid, 'Revoir les succès', boss.username], ['sanction', 'user', p.uid, REASON, boss.username]])
        assert.equal(actions[1].payload.sanction_id, s.sanction.id)
        const one = await ok(await get(env, `/audit?staff_id=${boss.uid}&target_type=user&target_id=${p.uid}&page=0`, boss.uid), Audit)
        assert.equal(one.actions.length, 2)
        assert.deepEqual((await ok(await get(env, `/audit?staff_id=${boss.uid}&page=1`, boss.uid), Audit)).actions, [])
        await refused(await get(env, '/audit?target_type=%00', boss.uid), 400, 'Caractère invalide', 'invalid_request')
      },
    },
  ]),
  spec('GET', '/users?q=ab', [
    {
      name: 'préfixe du pseudo → UserRow strict ; ?q=a → 400 exact',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        const p = player(env)
        const { users } = await ok(await get(env, `/users?q=${p.username.slice(0, 14)}`, mod.uid), Search)
        assert.deepEqual(users.find((u) => u.id === p.uid)?.deleted, false)
        await refused(await get(env, '/users?q=a', mod.uid), 400, 'Tape au moins 2 caractères', 'invalid_request')
      },
    },
  ]),
  spec('GET', '/users/{userId}', [
    {
      name: 'fiche stricte avec ses sanctions ; joueur inconnu → 404 exact',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        const p = player(env)
        await created(await sanction(env, boss.uid, p.uid, { kind: 'warning' }), Sanctioned)
        const d = await ok(await get(env, `/users/${p.uid}`, boss.uid), UserDetail)
        assert.deepEqual([d.user.id, d.user.username, d.staff_role, d.guild, d.user.auth_pending], [p.uid, p.username, null, null, false])
        assert.deepEqual(d.sanctions.map((s) => [s.kind, s.active, s.created_by_username]), [['warning', true, boss.username]])
        await refused(await get(env, `/users/${randomUUID()}`, boss.uid), 404, 'Joueur introuvable')
      },
    },
  ]),
  spec('POST', '/users/{userId}/sanctions', [
    {
      name: 'Review Focus — bannissement malgré un JWT valide : 201, GoTrue banni, écriture et lecture 403, levée → lecture 200 (D:1085)',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        const p = player(env)
        // Cookie (JWT) émis avant le bannissement, réutilisé tel quel après.
        const c = authCookie(env.backend, p.uid)
        const cookie = { cookie: `${c.name}=${c.value}` }
        const s = await created(await sanction(env, boss.uid, p.uid, { kind: 'ban' }), Sanctioned)
        assert.deepEqual([s.sanction.kind, s.sanction.active, s.auth.forever, s.auth_synced], ['ban', true, true, true])
        assert.notEqual(bannedUntil(env, p.uid), '')
        await blocked(await send(env, 'POST', '/api/packs/open', undefined, {}, { ...idem(), ...cookie }), null)
        await blocked(await api(env, '/api/my-collection', { headers: cookie }), null)
        const lifted = await ok(await post(env, `/sanctions/${s.sanction.id}/revoke`, boss.uid, { reason: 'Erreur de jugement' }), Sanctioned)
        assert.deepEqual([lifted.sanction.active, lifted.auth.forever, lifted.auth_synced], [false, false, true])
        assert.equal(bannedUntil(env, p.uid), '')
        assert.equal((await api(env, '/api/my-collection', { headers: cookie })).status, 200)
      },
    },
    {
      name: 'suspension datée → banned_until à 5 s de ends_at ; restriction → lecture 200, écriture 403',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        const [p, q] = [player(env), player(env)]
        const ends = inFuture(2 * 3600_000)
        const s = await created(await sanction(env, boss.uid, p.uid, { kind: 'suspension', ends_at: ends }), Sanctioned)
        assert.equal(s.auth_synced, true)
        assert.equal(sql(env, `select abs(extract(epoch from banned_until - :'e'::timestamptz)) < 5 from auth.users where id = :'u'`, { e: ends, u: p.uid }), 't')
        await created(await sanction(env, boss.uid, q.uid, { kind: 'restriction', ends_at: inFuture(3600_000) }), Sanctioned)
        assert.equal(bannedUntil(env, q.uid), '')
        assert.equal((await api(env, '/api/my-collection', { uid: q.uid })).status, 200)
        await blocked(await send(env, 'POST', '/api/packs/open', q.uid, {}, idem()))
      },
    },
    {
      name: 'modérateur qui bannit → 403 ; motif \'ab\' → 400 ; kind \'x\' → 400 zod ; même clé deux fois → corps identiques, un seul audit',
      run: async (env) => {
        const [boss, mod] = [staffOf(env, 'admin'), staffOf(env, 'moderator')]
        const p = player(env)
        await refused(await sanction(env, mod.uid, p.uid, { kind: 'ban' }), 403, ADMIN_ONLY, 'FORBIDDEN')
        await refused(await sanction(env, boss.uid, p.uid, { kind: 'warning', reason: 'ab' }), 400,
          'Le motif est obligatoire (3 à 500 caractères)', 'invalid_request')
        await refused(await sanction(env, boss.uid, p.uid, { kind: 'x' }), 400, 'Sanction inconnue', 'invalid_request')
        const key = idem()
        const first = await created(await sanction(env, boss.uid, p.uid, { kind: 'warning' }, key), Sanctioned)
        assert.deepEqual(await created(await sanction(env, boss.uid, p.uid, { kind: 'warning' }, key), Sanctioned), first)
        assert.equal(sql(env, `select count(*) from wm.staff_actions where target_id = :'u'`, { u: p.uid }), '1')
      },
    },
    {
      name: 'ligne JSON de route() : clés exactes, chemin masqué, ni pseudo ni motif',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        const p = player(env)
        const vercelId = randomUUID()
        await created(await sanction(env, boss.uid, p.uid, { kind: 'warning' }, { ...idem(), 'x-vercel-id': vercelId }), Sanctioned)
        // Journal du serveur lancé par le banc lui-même : ce cas ne vaut que si la suite démarre son propre serveur.
        const log = readFileSync(new URL('../../.cache/logs/next-plain.log', import.meta.url), 'utf8')
        const line = log.split('\n').find((l) => l.includes(vercelId))
        assert.ok(line)
        const entry = JSON.parse(line) as Record<string, unknown>
        assert.deepEqual(Object.keys(entry).sort(), ['ms', 'pg_code', 'route', 'rpc', 'status', 'uid_hash', 'vercel_id'])
        assert.deepEqual([entry.route, entry.status, entry.rpc], ['/api/admin/users/[userId]/sanctions', 201, 'admin_sanction'])
        for (const secret of [p.username, boss.username, REASON, p.uid, boss.uid]) assert.ok(!line.includes(secret), secret)
      },
    },
  ], { kind: 'warning', reason: REASON }),
  spec('POST', '/sanctions/{sanctionId}/revoke', [
    {
      name: 'sanction inconnue → 404 ; levée deux fois → 409 exact',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        await refused(await post(env, '/sanctions/2147483647/revoke', boss.uid, { reason: 'Levée' }), 404, 'Sanction introuvable')
        const s = await created(await sanction(env, boss.uid, player(env).uid, { kind: 'warning' }), Sanctioned)
        await ok(await post(env, `/sanctions/${s.sanction.id}/revoke`, boss.uid, { reason: 'Levée' }), Sanctioned)
        await refused(await post(env, `/sanctions/${s.sanction.id}/revoke`, boss.uid, { reason: 'Levée' }), 409, 'Cette sanction est déjà levée')
      },
    },
  ], { reason: REASON }),
  spec('POST', '/users/{userId}/auth-sync', [
    {
      name: 'banned_until effacé par psql → rétabli ; modérateur → 403',
      run: async (env) => {
        const [boss, mod] = [staffOf(env, 'admin'), staffOf(env, 'moderator')]
        const p = player(env)
        await created(await sanction(env, boss.uid, p.uid, { kind: 'ban' }), Sanctioned)
        sql(env, `update auth.users set banned_until = null where id = :'u'`, { u: p.uid })
        const s = await ok(await post(env, `/users/${p.uid}/auth-sync`, boss.uid, { reason: 'Session à resynchroniser' }), Synced)
        assert.deepEqual([s.auth.forever, s.auth_synced], [true, true])
        assert.notEqual(bannedUntil(env, p.uid), '')
        await refused(await post(env, `/users/${p.uid}/auth-sync`, mod.uid, { reason: 'Session à resynchroniser' }), 403, ADMIN_ONLY, 'FORBIDDEN')
      },
    },
  ], { reason: REASON }),
  spec('POST', '/users/{userId}/achievements-recheck', [
    {
      name: '{ok: true}, achievements_checked_at nul',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        const p = player(env)
        sql(env, `update wm.user_state set achievements_checked_at = now() where user_id = :'u'`, { u: p.uid })
        await ok(await post(env, `/users/${p.uid}/achievements-recheck`, mod.uid, { reason: 'Revoir les succès' }), Ok)
        assert.equal(sql(env, `select achievements_checked_at is null from wm.user_state where user_id = :'u'`, { u: p.uid }), 't')
      },
    },
  ], { reason: REASON }),
]
