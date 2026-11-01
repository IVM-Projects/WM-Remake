import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, authCookie, created, failed, giveCards, idem, Iso, makeUser, noSession, ok, psql, refused, send } from '../users.ts'
import { Card } from './catalog.ts'
import { guildWith } from './guilds.ts'
import { listed } from './market.ts'

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
const Who = z.strictObject({ id: z.uuid(), username: z.string().nullable() })
const ReportRow = z.strictObject({
  id: z.uuid(), reason: z.enum(['cheating', 'inappropriate_content', 'spam']), details: z.string().nullable(), created_at: Iso, reporter: Who, reported: Who,
  review: z.strictObject({ status: z.enum(['resolved', 'dismissed']), reviewed_at: Iso, reviewed_by_username: z.string().nullable() }).nullable(),
  active_sanctions: count,
})
const Reports = z.strictObject({ reports: z.array(ReportRow), hasMore: z.boolean() })
const Reviewed = z.strictObject({ ok: z.literal(true), status: z.enum(['resolved', 'dismissed']) })
const ImageReportRow = z.strictObject({
  card_id: z.uuid(), wikipedia_title: z.string(), image_url: z.string().nullable(), hide_image: z.boolean(), nsfw_image: z.boolean(),
  reports: count, last_reported_at: Iso,
})
const ImageReports = z.strictObject({ cards: z.array(ImageReportRow), hasMore: z.boolean() })
const DmMessage = z.strictObject({
  id: z.uuid(), sender_id: z.uuid(), recipient_id: z.uuid(), sender_username: z.string().nullable(), content: z.string(), created_at: Iso,
})
const DmThread = z.strictObject({ messages: z.array(DmMessage) })
const CardDetail = z.strictObject({
  card: z.strictObject({
    id: z.uuid(), wikipedia_title: z.string(), rarity: z.string(), image_url: z.string().nullable(), hide_image: z.boolean(), nsfw_image: z.boolean(),
    in_pool: z.boolean(),
  }),
  removal: z.strictObject({ reason: z.string(), removed_at: Iso, removed_by_username: z.string().nullable() }).nullable(),
  image_reports: count, quiz_bank: z.boolean(),
  engagements: z.strictObject({ active_auctions: count, pending_trades: count, open_wishes: count, showcase: count, avatars: count }),
})
const Flagged = z.strictObject({
  card: z.strictObject({ id: z.uuid(), hide_image: z.boolean(), nsfw_image: z.boolean() }), cleared_avatars: count, cleared_reports: count,
})
const Removed = z.strictObject({
  ok: z.literal(true), voided_auctions: count, cancelled_trades: count, removed_wishes: count, cleared_showcase: count, cleared_avatars: count,
  quiz_bank_deleted: z.boolean(),
})
const Cleared = z.strictObject({ ok: z.literal(true), deleted: z.boolean() })
const RemovalRow = z.strictObject({
  card_id: z.uuid(), wikipedia_title: z.string(), reason: z.string(), removed_at: Iso, removed_by_username: z.string().nullable(),
})
const Removals = z.strictObject({ removals: z.array(RemovalRow) })
const GuildRow = z.strictObject({ id: z.uuid(), name: z.string(), member_count: count, leader_username: z.string().nullable() })
const Guilds = z.strictObject({ guilds: z.array(GuildRow) })
const GuildDetail = z.strictObject({
  guild: z.strictObject({ id: z.uuid(), name: z.string(), description: z.string().nullable(), leader_id: z.uuid().nullable(), created_at: Iso }),
  members: z.array(z.strictObject({ user_id: z.uuid(), username: z.string(), role: z.enum(['leader', 'member']), joined_at: Iso })),
  messages: z.array(z.strictObject({ id: z.uuid(), user_id: z.uuid(), username: z.string(), content: z.string(), created_at: Iso })),
  wishes: z.array(z.strictObject({
    id: z.uuid(), user_id: z.uuid(), username: z.string(), card_id: z.uuid(), wikipedia_title: z.string(), created_at: Iso,
  })),
})
const Dissolved = z.strictObject({ ok: z.literal(true), members: count })
const ImageReportState = z.strictObject({ reported: z.boolean() })
const ImageReportSet = z.strictObject({ reported: z.boolean(), hidden: z.boolean() })
const CardsPage = z.object({ cards: z.array(Card) }).loose()

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
  const url = `/api/admin${path.replace('{sanctionId}', '1').replace(/\{[^}]+\}/g, () => randomUUID())}`
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
      name: 'modérateur qui bannit → 403 ; motif \'ab\' → 400 ; kind \'x\' et ends_at en 0000 → 400 zod ; même clé deux fois → corps identiques, un seul audit',
      run: async (env) => {
        const [boss, mod] = [staffOf(env, 'admin'), staffOf(env, 'moderator')]
        const p = player(env)
        await refused(await sanction(env, mod.uid, p.uid, { kind: 'ban' }), 403, ADMIN_ONLY, 'FORBIDDEN')
        await refused(await sanction(env, boss.uid, p.uid, { kind: 'warning', reason: 'ab' }), 400,
          'Le motif est obligatoire (3 à 500 caractères)', 'invalid_request')
        await refused(await sanction(env, boss.uid, p.uid, { kind: 'x' }), 400, 'Sanction inconnue', 'invalid_request')
        // Année 0000 : bien formée en RFC 3339, hors de timestamptz (22008) → 400 zod, jamais 500 ; aucune sanction.
        await refused(await sanction(env, boss.uid, p.uid, { kind: 'suspension', ends_at: '0000-06-15T00:00:00Z' }), 400, 'Date invalide',
          'invalid_request')
        assert.equal(sql(env, `select count(*) from wm.sanctions where user_id = :'u'`, { u: p.uid }), '0')
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

// Carte dédiée (jamais une carte du seed : la base du banc est partagée) : R à image unique, au pool ; supprimée par dropCard.
const cardTitle = () => `Zz modération contrat ${randomUUID().slice(-12)} z`
function dedicatedCard(env: ContractEnv): string {
  return sql(env, `select tests.image_card(:'t') as card \\gset
update public.cards set image_url = image_url || '#' || id where id = :'card';
select wm.pool_add(:'card', 'R');
\\echo :card`, { t: cardTitle() })
}
const titleOf = (env: ContractEnv, card: string) => sql(env, `select wikipedia_title from public.cards where id = :'c'`, { c: card })
function dropCard(env: ContractEnv, card: string): void {
  sql(env, `select wm.pool_remove(:'c');
delete from public.auctions where card_id = :'c';
delete from public.user_cards where card_id = :'c';
delete from wm.card_removals where card_id = :'c';
delete from public.cards where id = :'c'`, { c: card })
}
// Carte dédiée le temps de `fn`, supprimée quoi qu'il arrive.
async function withCard(env: ContractEnv, fn: (card: string, title: string) => Promise<void>): Promise<void> {
  const card = dedicatedCard(env)
  try {
    await fn(card, titleOf(env, card))
  } finally {
    dropCard(env, card)
  }
}
const found = async (env: ContractEnv, uid: string, card: string, title: string) =>
  (await ok(await api(env, `/api/cards?q=${encodeURIComponent(title.toLowerCase())}`, { uid }), CardsPage)).cards.find((c) => c.id === card)
const auditCount = (env: ContractEnv, action: string, target: string) =>
  sql(env, `select count(*) from wm.staff_actions where action = :'a' and target_id = :'t'`, { a: action, t: target })
const del = (env: ContractEnv, path: string, uid: string, body: unknown = { reason: REASON }, headers: Record<string, string> = idem()) =>
  send(env, 'DELETE', `/api/admin${path}`, uid, body, headers)
// C a signalé A ; renvoie l'id du signalement.
async function reported(env: ContractEnv, boss: string, a: string, c: string): Promise<string> {
  const res = await send(env, 'POST', '/api/reports', c, { reportedUserId: a, reason: 'spam' }, idem())
  assert.equal(res.status, 200)
  const { reports } = await ok(await get(env, '/reports', boss), Reports)
  const row = reports.find((r) => r.reporter.id === c && r.reported.id === a)
  assert.ok(row)
  return row.id
}
const dm = (env: ContractEnv, from: string, to: string, content: string) =>
  sql(env, `insert into public.chat_messages (sender_id, recipient_id, content) values (:'f', :'t', :'c') returning id`, { f: from, t: to, c: content })
const gone = (env: ContractEnv, table: string, id: string) => sql(env, `select count(*) from public.${table} where id = :'i'`, { i: id }) === '0'

const NO_BODY = { reason: REASON }

export const adminOps: RouteSpec[] = [
  spec('GET', '/reports', [
    {
      name: 'C signale A → listé (ReportRow strict) ; resolved → plus dans open, présent dans reviewed ; status \'x\' → 400 « Statut inconnu »',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        const [a, c] = [player(env).uid, player(env).uid]
        const id = await reported(env, mod.uid, a, c)
        await ok(await post(env, `/reports/${id}/review`, mod.uid, { status: 'resolved', reason: REASON }), Reviewed)
        assert.ok(!(await ok(await get(env, '/reports', mod.uid), Reports)).reports.some((r) => r.id === id))
        const done = (await ok(await get(env, '/reports?status=reviewed', mod.uid), Reports)).reports.find((r) => r.id === id)
        assert.deepEqual([done?.review?.status, done?.review?.reviewed_by_username], ['resolved', mod.username])
        await refused(await get(env, '/reports?status=x', mod.uid), 400, 'Statut inconnu', 'invalid_request')
      },
    },
  ]),
  spec('POST', '/reports/{reportId}/review', [
    {
      name: 'dismissed puis resolved → dernier statut ; inconnu → 404 exact ; status \'x\' → 400 ; même clé deux fois → corps identiques, un seul audit',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        const id = await reported(env, mod.uid, player(env).uid, player(env).uid)
        const key = idem()
        const first = await ok(await post(env, `/reports/${id}/review`, mod.uid, { status: 'dismissed', reason: REASON }, key), Reviewed)
        assert.deepEqual(await ok(await post(env, `/reports/${id}/review`, mod.uid, { status: 'dismissed', reason: REASON }, key), Reviewed), first)
        assert.equal(auditCount(env, 'report_review', id), '1')
        assert.equal((await ok(await post(env, `/reports/${id}/review`, mod.uid, { status: 'resolved', reason: REASON }), Reviewed)).status, 'resolved')
        await refused(await post(env, `/reports/${randomUUID()}/review`, mod.uid, { status: 'resolved', reason: REASON }), 404, 'Signalement introuvable')
        await refused(await post(env, `/reports/${id}/review`, mod.uid, { status: 'x', reason: REASON }), 400, 'Statut inconnu', 'invalid_request')
      },
    },
  ], { status: 'resolved', reason: REASON }),
  spec('GET', '/image-reports', [
    {
      name: 'carte signalée par 3 joueurs → ImageReportRow strict en tête',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        await withCard(env, async (card) => {
          for (let i = 0; i < 3; i++) await ok(await send(env, 'POST', `/api/cards/${card}/image-report`, player(env).uid, undefined, idem()), ImageReportSet)
          const { cards } = await ok(await get(env, '/image-reports', mod.uid), ImageReports)
          assert.deepEqual([cards[0].card_id, cards[0].reports, cards[0].hide_image], [card, 3, false])
        })
      },
    },
  ]),
  spec('POST', '/dm-thread', [
    {
      name: 'paire signalée A–C → les messages (DmMessage strict), un audit par lecture ; A–B sans signalement → 403 exact',
      run: async (env) => {
        const [mod, a, b, c] = [staffOf(env, 'moderator'), player(env).uid, player(env).uid, player(env).uid]
        await reported(env, mod.uid, a, c)
        dm(env, a, c, 'premier')
        dm(env, c, a, 'second')
        const thread = await ok(await post(env, '/dm-thread', mod.uid, { user_a: a, user_b: c, reason: REASON }, {}), DmThread)
        assert.deepEqual(thread.messages.map((m) => m.content), ['premier', 'second'])
        await ok(await post(env, '/dm-thread', mod.uid, { user_a: c, user_b: a, reason: REASON }, {}), DmThread)
        assert.equal(auditCount(env, 'dm_read', [a, c].sort().join(':')), '2')
        await refused(await post(env, '/dm-thread', mod.uid, { user_a: a, user_b: b, reason: REASON }, {}), 403, 'Aucun signalement entre ces deux joueurs', 'FORBIDDEN')
      },
    },
  ], { user_a: randomUUID(), user_b: randomUUID(), reason: REASON }),
  spec('DELETE', '/dms/{messageId}', [
    {
      name: '{ok: true}, ligne absente (psql), puis 404 exact ; paire non signalée → 403 ; même clé deux fois → un seul audit',
      run: async (env) => {
        const [mod, a, b, c] = [staffOf(env, 'moderator'), player(env).uid, player(env).uid, player(env).uid]
        await reported(env, mod.uid, a, c)
        const id = dm(env, a, c, 'à retirer')
        const key = idem()
        assert.deepEqual(await ok(await del(env, `/dms/${id}`, mod.uid, NO_BODY, key), Ok), { ok: true })
        assert.deepEqual(await ok(await del(env, `/dms/${id}`, mod.uid, NO_BODY, key), Ok), { ok: true })
        assert.equal(auditCount(env, 'dm_delete', id), '1')
        assert.ok(gone(env, 'chat_messages', id))
        await refused(await del(env, `/dms/${id}`, mod.uid), 404, 'Message introuvable')
        await refused(await del(env, `/dms/${dm(env, a, b, 'hors signalement')}`, mod.uid), 403, 'Aucun signalement entre ces deux joueurs', 'FORBIDDEN')
      },
    },
  ], NO_BODY),
  spec('GET', '/cards/{cardId}', [
    {
      name: 'fiche stricte d\'une carte dédiée ; inconnue → 404 « Carte introuvable » ; abc → 400',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        await withCard(env, async (card) => {
          const d = await ok(await get(env, `/cards/${card}`, mod.uid), CardDetail)
          assert.deepEqual([d.card.in_pool, d.removal, d.image_reports, d.quiz_bank], [true, null, 0, false])
        })
        await refused(await get(env, `/cards/${randomUUID()}`, mod.uid), 404, 'Carte introuvable')
        await failed(await get(env, '/cards/abc', mod.uid), 400, 'invalid_request')
      },
    },
  ]),
  spec('POST', '/cards/{cardId}/flags', [
    {
      name: 'Review Focus — image : 10 signaleurs masquent X (10e → hidden), flags levés → cleared_reports 9, X lisible dès la requête suivante (expire: 0)',
      run: async (env) => {
        const [mod, reader] = [staffOf(env, 'moderator'), player(env).uid]
        await withCard(env, async (card, title) => {
          const players = Array.from({ length: 10 }, () => player(env).uid)
          for (const [i, uid] of players.entries()) {
            const set = await ok(await send(env, 'POST', `/api/cards/${card}/image-report`, uid, undefined, idem()), ImageReportSet)
            assert.deepEqual(set, { reported: true, hidden: i === 9 })
          }
          assert.deepEqual(await ok(await api(env, `/api/cards/${card}/image-report`, { uid: players[0] }), ImageReportState), { reported: true })
          assert.deepEqual(await ok(await send(env, 'DELETE', `/api/cards/${card}/image-report`, players[0], undefined, idem()), ImageReportSet),
            { reported: false, hidden: true })
          const top = (await ok(await get(env, '/image-reports', mod.uid), ImageReports)).cards[0]
          assert.deepEqual([top.card_id, top.reports, top.hide_image], [card, 9, true])
          // Deux lectures : la copie partagée est remplie, image masquée.
          for (let i = 0; i < 2; i++) assert.equal((await found(env, reader, card, title))?.hide_image, true)
          const flagged = await ok(await post(env, `/cards/${card}/flags`, mod.uid, { hide_image: false, nsfw_image: false, reason: REASON }), Flagged)
          assert.deepEqual([flagged.card.hide_image, flagged.cleared_reports], [false, 9])
          assert.equal((await found(env, reader, card, title))?.hide_image, false)
          await failed(await post(env, '/cards/abc/flags', mod.uid, { hide_image: false, nsfw_image: false, reason: REASON }), 400, 'invalid_request')
        })
      },
    },
    {
      name: 'carte inconnue → 404 ; même clé deux fois → corps identiques, un seul audit',
      run: async (env) => {
        const mod = staffOf(env, 'moderator')
        await refused(await post(env, `/cards/${randomUUID()}/flags`, mod.uid, { hide_image: true, nsfw_image: false, reason: REASON }), 404, 'Carte introuvable')
        await withCard(env, async (card) => {
          const key = idem()
          const body = { hide_image: true, nsfw_image: true, reason: REASON }
          const first = await ok(await post(env, `/cards/${card}/flags`, mod.uid, body, key), Flagged)
          assert.deepEqual(await ok(await post(env, `/cards/${card}/flags`, mod.uid, body, key), Flagged), first)
          assert.equal(auditCount(env, 'card_flags', card), '1')
        })
      },
    },
  ], { hide_image: false, nsfw_image: false, reason: REASON }),
  spec('POST', '/cards/{cardId}/removal', [
    {
      name: 'Review Focus — retrait : enchère dénouée, mise remboursée, Y absente de la recherche dès la requête suivante (G15) ; 409 ; modérateur 403',
      run: async (env) => {
        const [boss, mod, reader] = [staffOf(env, 'admin'), staffOf(env, 'moderator'), player(env).uid]
        await withCard(env, async (card, title) => {
          const seller = makeUser(db(env), { humanVerified: true })
          const bidder = makeUser(db(env), { balance: 1000, humanVerified: true })
          const copy = sql(env, `insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'u', id, wikipedia_title, rarity, category, atk, def from public.cards where id = :'c' returning id`, { u: seller.uid, c: card })
          const auction = listed(env, seller.uid, copy)
          await ok(await send(env, 'POST', `/api/marketplace/${auction}/bid`, bidder.uid, { amount: 100 }, idem()), z.object({}).loose())
          assert.equal(sql(env, `select wikibidous_balance from public.profiles where id = :'u'`, { u: bidder.uid }), '900')
          assert.equal((await found(env, reader, card, title))?.id, card)
          await refused(await post(env, `/cards/${card}/removal`, mod.uid, NO_BODY), 403, ADMIN_ONLY, 'FORBIDDEN')
          const done = await created(await post(env, `/cards/${card}/removal`, boss.uid, NO_BODY), Removed)
          assert.deepEqual(done, { ok: true, voided_auctions: 1, cancelled_trades: 0, removed_wishes: 0, cleared_showcase: 0, cleared_avatars: 0, quiz_bank_deleted: false })
          assert.equal(await found(env, reader, card, title), undefined)
          assert.equal(sql(env, `select wikibidous_balance from public.profiles where id = :'u'`, { u: bidder.uid }), '1000')
          assert.equal(sql(env, `select status from public.auctions where id = :'a'`, { a: auction }), 'cancelled')
          await refused(await post(env, `/cards/${card}/removal`, boss.uid, NO_BODY), 409, 'Cette carte est déjà retirée')
          const detail = await ok(await get(env, `/cards/${card}`, mod.uid), CardDetail)
          assert.deepEqual([detail.card.in_pool, detail.removal?.reason], [false, REASON])
          assert.equal(sql(env, 'select wm.check_invariants()'), '[]')
        })
      },
    },
    {
      name: 'même clé deux fois → corps identiques, un seul audit ; carte inconnue → 404',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        await refused(await post(env, `/cards/${randomUUID()}/removal`, boss.uid, NO_BODY), 404, 'Carte introuvable')
        await withCard(env, async (card) => {
          const key = idem()
          const first = await created(await post(env, `/cards/${card}/removal`, boss.uid, NO_BODY, key), Removed)
          assert.deepEqual(await created(await post(env, `/cards/${card}/removal`, boss.uid, NO_BODY, key), Removed), first)
          assert.equal(auditCount(env, 'card_remove', card), '1')
        })
      },
    },
  ], NO_BODY),
  spec('DELETE', '/cards/{cardId}/removal', [
    {
      name: 'remise → {ok: true}, Y de nouveau dans la recherche dès la requête suivante ; non retirée → 409 exact ; modérateur 403',
      run: async (env) => {
        const [boss, mod, reader] = [staffOf(env, 'admin'), staffOf(env, 'moderator'), player(env).uid]
        await withCard(env, async (card, title) => {
          await refused(await del(env, `/cards/${card}/removal`, boss.uid), 409, 'Cette carte n\'est pas retirée')
          await created(await post(env, `/cards/${card}/removal`, boss.uid, NO_BODY), Removed)
          assert.equal(await found(env, reader, card, title), undefined)
          await refused(await del(env, `/cards/${card}/removal`, mod.uid), 403, ADMIN_ONLY, 'FORBIDDEN')
          assert.deepEqual(await ok(await del(env, `/cards/${card}/removal`, boss.uid), Ok), { ok: true })
          assert.equal((await found(env, reader, card, title))?.id, card)
          assert.equal(sql(env, 'select wm.check_invariants()'), '[]')
        })
      },
    },
  ], NO_BODY),
  spec('POST', '/cards/{cardId}/quiz-clear', [
    {
      name: '{ok: true, deleted} ; inconnue → 404 ; modérateur → 403',
      run: async (env) => {
        const [boss, mod] = [staffOf(env, 'admin'), staffOf(env, 'moderator')]
        await withCard(env, async (card) => {
          assert.deepEqual(await ok(await post(env, `/cards/${card}/quiz-clear`, boss.uid, NO_BODY), Cleared), { ok: true, deleted: false })
          await refused(await post(env, `/cards/${card}/quiz-clear`, mod.uid, NO_BODY), 403, ADMIN_ONLY, 'FORBIDDEN')
        })
        await refused(await post(env, `/cards/${randomUUID()}/quiz-clear`, boss.uid, NO_BODY), 404, 'Carte introuvable')
      },
    },
  ], NO_BODY),
  spec('GET', '/removals', [
    {
      name: 'carte retirée → RemovalRow strict en tête',
      run: async (env) => {
        const boss = staffOf(env, 'admin')
        await withCard(env, async (card, title) => {
          await created(await post(env, `/cards/${card}/removal`, boss.uid, NO_BODY), Removed)
          const { removals } = await ok(await get(env, '/removals', boss.uid), Removals)
          assert.deepEqual([removals[0].card_id, removals[0].wikipedia_title, removals[0].reason, removals[0].removed_by_username],
            [card, title, REASON, boss.username])
        })
      },
    },
  ]),
  spec('GET', '/guilds?q=ab', [
    {
      name: 'fragment du nom → GuildRow strict ; ?q=a → 400 exact',
      run: async (env) => {
        const [mod, leader, member] = [staffOf(env, 'moderator'), player(env), player(env)]
        const g = guildWith(env, leader.uid, [member.uid])
        const name = sql(env, `select name from public.guilds where id = :'g'`, { g })
        const row = (await ok(await get(env, `/guilds?q=${name}`, mod.uid), Guilds)).guilds.find((x) => x.id === g)
        assert.deepEqual([row?.name, row?.member_count, row?.leader_username], [name, 2, leader.username])
        await refused(await get(env, '/guilds?q=a', mod.uid), 400, 'Tape au moins 2 caractères', 'invalid_request')
      },
    },
  ]),
  spec('GET', '/guilds/{guildId}', [
    {
      name: 'détail strict (membres, messages, souhaits) ; guilde inconnue → 404 exact',
      run: async (env) => {
        const [mod, leader, member] = [staffOf(env, 'moderator'), player(env), player(env)]
        const g = guildWith(env, leader.uid, [member.uid])
        const [copy] = giveCards(db(env), member.uid, 'C')
        sql(env, `select wm.guild_wish_set(:'u', (select card_id from public.user_cards where id = :'c'))`, { u: member.uid, c: copy })
        sql(env, `insert into public.guild_chat_messages (guild_id, user_id, content) values (:'g', :'u', 'salut')`, { g, u: leader.uid })
        const d = await ok(await get(env, `/guilds/${g}`, mod.uid), GuildDetail)
        assert.deepEqual([d.guild.id, d.members.map((m) => m.role), d.messages.map((m) => m.content), d.wishes.map((w) => w.user_id)],
          [g, ['leader', 'member'], ['salut'], [member.uid]])
        await refused(await get(env, `/guilds/${randomUUID()}`, mod.uid), 404, 'Guilde introuvable')
      },
    },
  ]),
  spec('DELETE', '/guilds/{guildId}', [
    {
      name: 'dissolution → {ok, members: 2}, guilde absente (psql), 404 exact au second appel ; modérateur → 403',
      run: async (env) => {
        const [boss, mod, leader, member] = [staffOf(env, 'admin'), staffOf(env, 'moderator'), player(env), player(env)]
        const g = guildWith(env, leader.uid, [member.uid])
        await refused(await del(env, `/guilds/${g}`, mod.uid), 403, ADMIN_ONLY, 'FORBIDDEN')
        assert.deepEqual(await ok(await del(env, `/guilds/${g}`, boss.uid), Dissolved), { ok: true, members: 2 })
        assert.ok(gone(env, 'guilds', g))
        assert.equal(sql(env, `select count(*) from public.guild_members where guild_id = :'g'`, { g }), '0')
        await refused(await del(env, `/guilds/${g}`, boss.uid), 404, 'Guilde introuvable')
      },
    },
  ], NO_BODY),
  spec('DELETE', '/guild-messages/{messageId}', [
    {
      name: 'message supprimé → {ok: true}, absent (psql), 404 exact ensuite',
      run: async (env) => {
        const [mod, leader] = [staffOf(env, 'moderator'), player(env)]
        const g = guildWith(env, leader.uid)
        const id = sql(env, `insert into public.guild_chat_messages (guild_id, user_id, content) values (:'g', :'u', 'à retirer') returning id`, { g, u: leader.uid })
        assert.deepEqual(await ok(await del(env, `/guild-messages/${id}`, mod.uid), Ok), { ok: true })
        assert.ok(gone(env, 'guild_chat_messages', id))
        await refused(await del(env, `/guild-messages/${id}`, mod.uid), 404, 'Message introuvable')
      },
    },
  ], NO_BODY),
  spec('DELETE', '/guild-wishes/{wishId}', [
    {
      name: 'souhait retiré → {ok: true}, absent (psql), 404 exact ensuite',
      run: async (env) => {
        const [mod, leader] = [staffOf(env, 'moderator'), player(env)]
        guildWith(env, leader.uid)
        const [copy] = giveCards(db(env), leader.uid, 'C')
        const id = sql(env, `select wm.guild_wish_set(:'u', (select card_id from public.user_cards where id = :'c')) -> 'wishlist' ->> 'id'`, { u: leader.uid, c: copy })
        assert.deepEqual(await ok(await del(env, `/guild-wishes/${id}`, mod.uid), Ok), { ok: true })
        assert.ok(gone(env, 'guild_wishlists', id))
        await refused(await del(env, `/guild-wishes/${id}`, mod.uid), 404, 'Ce souhait n\'existe plus')
      },
    },
  ], NO_BODY),
]

const imageUrl = (card: string) => `/api/cards/${card}/image-report`
const imageSpec = (method: RouteSpec['method'], cases: RouteSpec['cases']): RouteSpec => ({
  method, path: '/api/cards/{id}/image-report', source: 'D:638', confidence: 'ajouté',
  cases: [
    noSession(method, imageUrl(randomUUID())),
    {
      name: 'id=abc → 400 invalid_request ; carte inconnue → 404 « Carte introuvable » (écritures)',
      run: async (env) => {
        const uid = player(env).uid
        await failed(await send(env, method, imageUrl('abc'), uid, undefined, idem()), 400, 'invalid_request')
        if (method !== 'GET') await refused(await send(env, method, imageUrl(randomUUID()), uid, undefined, idem()), 404, 'Carte introuvable')
      },
    },
    ...cases,
  ],
})

export const imageReport: RouteSpec[] = [
  imageSpec('GET', [
    {
      name: '{reported: false} puis {reported: true} après son signalement, pas celui d\'un autre',
      run: async (env) => {
        const [me, other] = [player(env).uid, player(env).uid]
        await withCard(env, async (card) => {
          assert.deepEqual(await ok(await api(env, imageUrl(card), { uid: me }), ImageReportState), { reported: false })
          await ok(await send(env, 'POST', imageUrl(card), other, undefined, idem()), ImageReportSet)
          assert.deepEqual(await ok(await api(env, imageUrl(card), { uid: me }), ImageReportState), { reported: false })
          assert.deepEqual(await ok(await api(env, imageUrl(card), { uid: other }), ImageReportState), { reported: true })
        })
      },
    },
  ]),
  imageSpec('POST', [
    {
      name: 'signalement → {reported: true, hidden: false} ; rejoué (même clé) → corps identique, une seule ligne ; sans clé → ligne unique',
      run: async (env) => {
        const uid = player(env).uid
        await withCard(env, async (card) => {
          const key = idem()
          const first = await ok(await send(env, 'POST', imageUrl(card), uid, undefined, key), ImageReportSet)
          assert.deepEqual(first, { reported: true, hidden: false })
          assert.deepEqual(await ok(await send(env, 'POST', imageUrl(card), uid, undefined, key), ImageReportSet), first)
          await ok(await send(env, 'POST', imageUrl(card), uid, undefined, idem()), ImageReportSet)
          assert.equal(sql(env, `select count(*) from wm.card_image_reports where card_id = :'c'`, { c: card }), '1')
        })
      },
    },
  ]),
  imageSpec('DELETE', [
    {
      name: 'retrait → {reported: false, hidden: false} ; sans signalement préalable, idem',
      run: async (env) => {
        const uid = player(env).uid
        await withCard(env, async (card) => {
          await ok(await send(env, 'POST', imageUrl(card), uid, undefined, idem()), ImageReportSet)
          assert.deepEqual(await ok(await send(env, 'DELETE', imageUrl(card), uid, undefined, idem()), ImageReportSet), { reported: false, hidden: false })
          assert.deepEqual(await ok(await send(env, 'DELETE', imageUrl(card), uid, undefined, idem()), ImageReportSet), { reported: false, hidden: false })
        })
      },
    },
  ]),
]
