import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { SECRET_KEY } from '../harness.ts'
import { forbiddenKeys } from '../leak.ts'
import { api, failed, giveCards, idem, makeUser, noSession, ok, psql, refused, send } from '../users.ts'
import { befriend } from './friends.ts'
import { guildWith } from './guilds.ts'
import { listed } from './market.ts'

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const UNAUTHORIZED = 'Session expirée, reconnecte-toi.'
const EXPORT = '/api/settings/export'
const DELETE = '/api/settings/delete-account'

// Clés de premier niveau de wm.account_export (Task 7, 2260).
const EXPORT_KEYS = ['account', 'achievements', 'auctions_sold', 'battles', 'bids', 'cards', 'format', 'friends', 'generated_at', 'grace_grants',
  'guild', 'image_reports', 'ledger', 'messages', 'notification_prefs', 'notifications', 'preferences', 'pro_daily_claims', 'push_subscriptions',
  'reports_filed', 'sanctions', 'showcase', 'special_pack_claims', 'staff_role', 'state', 'stats', 'tags', 'trades', 'version', 'wishlist']

// Clés des abonnements push jamais exportées (G10), cherchées à toute profondeur.
const PUSH_SECRETS = new Set(['p256dh', 'auth'])
function pushSecretPaths(body: unknown): string[] {
  const found: string[] = []
  const walk = (v: unknown, path: string[]) => {
    if (v === null || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) {
      if (PUSH_SECRETS.has(k)) found.push([...path, k].join('.'))
      walk(x, [...path, k])
    }
  }
  walk(body, [])
  return found
}

const Deleted = z.strictObject({
  ok: z.literal(true), voided_auctions: z.int(), cancelled_trades: z.int(), finished_battles: z.int(), cancelled_battles: z.int(),
  guild: z.enum(['left', 'transferred', 'dissolved']).nullable(), auth_pending: z.boolean(),
})

// Connexion GoTrue par mot de passe (comme supabase-js), via la passerelle.
const login = (env: ContractEnv, email: string, password: string) =>
  fetch(`${env.backend.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: 'sb_publishable_test', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  })

// Joueur inscrit par l'API admin de GoTrue (identité et métadonnées comme une vraie inscription), vérifié humain comme makeUser.
async function gotrueUser(env: ContractEnv, created: string[]): Promise<{ uid: string; username: string; email: string; password: string }> {
  const username = `d_${randomUUID().slice(-12)}`
  const email = `${randomUUID()}@test.local`
  const password = 'mot-de-passe-de-test'
  const res = await fetch(`${env.backend.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: SECRET_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username, age_confirmed: true, terms_version: 'test' } }),
  })
  const text = await res.text()
  assert.equal(res.status, 200, text.slice(0, 500))
  const uid = (JSON.parse(text) as { id: string }).id
  created.push(uid)
  sql(env, `insert into wm.user_state (user_id, human_verified_until) values (:'u', now() + interval '12 hours')
on conflict (user_id) do update set human_verified_until = excluded.human_verified_until`, { u: uid })
  return { uid, username, email, password }
}

export const account: RouteSpec[] = [
  {
    method: 'GET',
    path: EXPORT,
    source: 'D:364',
    confidence: 'ajouté',
    cases: [
      noSession('GET', EXPORT),
      {
        name: 'Review Focus : 200 en pièce jointe, no-store, clés de la Task 7 ; ni p256dh ni auth, ni secret de quiz, ni signalement reçu, '
          + 'ni e-mail d\'un ami ; aussitôt de nouveau → 429, Retry-After de 1 à 600',
        run: async (env) => {
          assert.deepEqual(pushSecretPaths({ a: [{ p256dh: 1 }] }), ['a.0.p256dh']) // témoin du parcours
          const me = makeUser(db(env))
          const friend = makeUser(db(env))
          befriend(env, me.uid, friend.uid)
          sql(env, `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (:'u', 'https://push.invalid/' || :'u', 'p', 'k')`,
            { u: me.uid })
          const report = sql(env, `insert into public.reports (reporter_id, reported_user_id, reason) values (:'f', :'u', 'spam') returning id`,
            { f: friend.uid, u: me.uid })
          const res = await api(env, EXPORT, { uid: me.uid })
          const text = await res.text()
          assert.equal(res.status, 200, text.slice(0, 500))
          assert.equal(res.headers.get('content-disposition'), 'attachment; filename="export-compte.json"')
          assert.equal(res.headers.get('cache-control'), 'no-store')
          const body = JSON.parse(text) as Record<string, unknown> & { push_subscriptions: unknown[]; friends: unknown[] }
          assert.deepEqual(Object.keys(body).sort(), EXPORT_KEYS)
          assert.deepEqual([body.format, body.version, body.push_subscriptions.length, body.friends.length], ['export-compte', 1, 1, 1])
          assert.deepEqual(forbiddenKeys(body, false), [])
          assert.deepEqual(pushSecretPaths(body), [])
          assert.ok(!text.includes(report), 'id du signalement reçu')
          assert.ok(!text.includes(`${friend.uid}@test.local`), 'e-mail de l\'ami')
          const again = await api(env, EXPORT, { uid: me.uid })
          await failed(again, 429)
          const after = Number(again.headers.get('retry-after'))
          assert.ok(Number.isInteger(after) && after >= 1 && after <= 600, `Retry-After: ${after}`)
        },
      },
      {
        name: 'joueur suspendu → 403 restreint',
        run: async (env) => {
          const { uid } = makeUser(db(env))
          sql(env, `insert into wm.sanctions (user_id, kind, reason, ends_at) values (:'u', 'suspension', 'test', now() + interval '1 hour')`, { u: uid })
          const body = await failed(await api(env, EXPORT, { uid }), 403)
          assert.equal(body.error, 'Ton compte est temporairement restreint.')
        },
      },
    ],
  },
  {
    method: 'POST',
    path: DELETE,
    source: 'D:365',
    confidence: 'ajouté',
    cases: [
      noSession('POST', DELETE),
      {
        name: 'Review Focus, suppression de bout en bout (D:1085) : enchère dénouée, échange annulé, guilde transmise, message gardé, '
          + 'pierre tombale, GoTrue en suppression douce (ligne gardée, connexion refusée), 401 ensuite, rejeu identique, invariants',
        timeout: 60_000,
        run: async (env) => {
          const created: string[] = [] // utilisateurs GoTrue à supprimer, notés dès leur création
          try {
            const d = await gotrueUser(env, created)
            const x = await gotrueUser(env, created) // témoin : son journal GoTrue ne bouge pas
            const [m, e, h] = [makeUser(db(env), { balance: 1000, humanVerified: true }), makeUser(db(env)), makeUser(db(env))]
            const [sold, offered] = giveCards(db(env), d.uid, 'C', 2)
            const eCopy = giveCards(db(env), e.uid, 'C')[0]
            const auction = listed(env, d.uid, sold)
            sql(env, `select wm.place_bid(:'m', :'a', 100)`, { m: m.uid, a: auction })
            befriend(env, d.uid, e.uid)
            const trade = sql(env, `select wm.create_trade(:'d', :'e', (select jsonb_agg(jsonb_build_object('user_card_id', id, 'card_id', card_id,
              'offered_by', user_id) order by id) from public.user_cards where id in (:'o', :'c'))) ->> 'id'`, { d: d.uid, e: e.uid, o: offered, c: eCopy })
            const guild = guildWith(env, d.uid, [h.uid])
            sql(env, `insert into public.chat_messages (sender_id, recipient_id, content) values (:'d', :'e', 'bonjour')`, { d: d.uid, e: e.uid })
            assert.equal((await login(env, x.email, x.password)).status, 200)
            const audit = (u: { uid: string; email: string }) => sql(env, `select count(*) from auth.audit_log_entries a
              where a::text like '%' || :'e' || '%' or a::text like '%' || :'u' || '%'`, { e: u.email, u: u.uid })
            const xAudit = audit(x)
            assert.ok(Number(xAudit) >= 2, xAudit) // user_signedup et login
            const session = await login(env, d.email, d.password)
            assert.equal(session.status, 200)
            const { refresh_token: refreshToken } = (await session.json()) as { refresh_token: string }
            // Témoin : l'e-mail d'origine est bien là où une vraie inscription le garde (ligne et identité).
            assert.equal(sql(env, `select (select count(*) from auth.users u where id = :'d' and u::text like '%' || :'e' || '%')
              || '|' || (select count(*) from auth.identities where user_id = :'d' and identity_data::text like '%' || :'e' || '%')`,
            { d: d.uid, e: d.email }), '1|1')

            await refused(await send(env, 'POST', DELETE, d.uid, { username: 'mauvais' }, idem()), 400,
              'Tape ton pseudo exactement pour confirmer', 'invalid_request')
            const key = idem()
            const first = await ok(await send(env, 'POST', DELETE, d.uid, { username: d.username }, key), Deleted)
            assert.deepEqual(first, {
              ok: true, voided_auctions: 1, cancelled_trades: 1, finished_battles: 0, cancelled_battles: 0, guild: 'transferred', auth_pending: false,
            })

            // Observé sur GoTrue v2.197.0 : la suppression douce garde la ligne, pose deleted_at, efface l'e-mail de la ligne, de ses
            // métadonnées et des identités, et coupe connexion et renouvellement.
            assert.equal(sql(env, `select count(*) || '|' || bool_and(deleted_at is not null) || '|' || bool_and(email is distinct from :'e')
              || '|' || bool_and(u::text not like '%' || :'e' || '%')
              || '|' || bool_and(coalesce(raw_user_meta_data::text, '') || coalesce(raw_app_meta_data::text, '') not like '%' || :'e' || '%')
              from auth.users u where id = :'d'`, { d: d.uid, e: d.email }), '1|true|true|true|true')
            assert.equal(sql(env, `select count(*) from auth.identities where user_id = :'d'
              and (email is not null or identity_data::text like '%' || :'e' || '%')`, { d: d.uid, e: d.email }), '0')
            // G1 : le journal GoTrue de D (user_signedup, login, user_deleted) purgé par account_auth_done, celui de X intact.
            assert.equal(audit(d), '0') // ni l'e-mail d'origine ni l'id de D
            assert.equal(audit(x), xAudit)
            const denied = await login(env, d.email, d.password)
            assert.equal(denied.status, 400)
            assert.equal(((await denied.json()) as { error_code: string }).error_code, 'invalid_credentials')
            const refreshed = await fetch(`${env.backend.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
              method: 'POST', headers: { apikey: 'sb_publishable_test', 'content-type': 'application/json' },
              body: JSON.stringify({ refresh_token: refreshToken }),
            })
            assert.equal(refreshed.status, 400)
            assert.equal(((await refreshed.json()) as { error_code: string }).error_code, 'refresh_token_not_found')
            assert.match(sql(env, `select username from public.profiles where id = :'d'`, { d: d.uid }), /^Joueur supprimé [0-9a-f]{8}$/)
            assert.equal(sql(env, `select auth_done_at is not null from wm.deleted_accounts where user_id = :'d'`, { d: d.uid }), 't')
            assert.equal(sql(env, `select wikibidous_balance from public.profiles where id = :'m'`, { m: m.uid }), '1000')
            assert.equal(sql(env, `select status from public.trades where id = :'t'`, { t: trade }), 'cancelled')
            assert.equal(sql(env, `select leader_id from public.guilds where id = :'g'`, { g: guild }), h.uid)
            assert.equal(sql(env, `select count(*) from public.chat_messages where sender_id = :'d' and recipient_id = :'e'`, { d: d.uid, e: e.uid }), '1')

            await refused(await api(env, '/api/my-collection', { uid: d.uid }), 401, UNAUTHORIZED, 'unauthorized')
            await refused(await send(env, 'POST', '/api/packs/open', d.uid, {}, idem()), 401, UNAUTHORIZED, 'unauthorized')
            assert.deepEqual(await ok(await send(env, 'POST', DELETE, d.uid, { username: d.username }, key), Deleted), first)
            assert.equal(sql(env, `select wm.check_invariants()`), '[]')
          } finally {
            // Garde des pierres tombales levée pour cette session psql seulement (Task 6a) ; la ligne GoTrue survit à la suppression douce.
            sql(env, `select set_config('wm.allow_tombstone_delete', 'on', false);
delete from auth.users where id = any (string_to_array(:'ids', ',')::uuid[])`, { ids: created.join(',') })
          }
        },
      },
    ],
  },
]
