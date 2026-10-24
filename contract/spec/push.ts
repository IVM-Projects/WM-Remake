import assert from 'node:assert/strict'
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { brand } from '../../lib/brand.ts'
import { CRON_SECRET, PUSH_SINK } from '../harness.ts'
import { decryptPush, verifyVapid } from '../push-crypto.ts'
import { created, failed, idem, makeUser, noSession, ok, psql, refused, send } from '../users.ts'
import { befriend } from './friends.ts'

// Preuve de D:1083 (« un push reçu sur un point d'entrée de test en CI ») : le faux service de la passerelle enregistre chaque livraison
// (M4b-32), la spec la déchiffre (RFC 8291) et vérifie son JWT VAPID. Chaque cas pose ses joueurs et ses endpoints neufs.
const Ok = z.strictObject({ ok: z.literal(true) })
const Prefs = z.strictObject({ push_types: z.array(z.string()), vapid_public: z.string().regex(/^[A-Za-z0-9_-]{87}$/) })
const Counts = z.strictObject({ sent: z.int(), gone: z.int(), failed: z.int() })
const Friendship = z.object({ friendship: z.object({ id: z.uuid() }) })
type Delivery = { headers: Record<string, string>; body_b64: string }
type Subscriber = { uid: string; username: string; endpoint: string; ua: ReturnType<typeof createECDH>; auth: Buffer; vapid_public: string }

const SUBSCRIBE = '/api/push/subscribe'
const SETTINGS = '/api/settings/notifications'
const UNSUPPORTED = 'Service de notifications non pris en charge'
const SINK_ORIGIN = new URL(PUSH_SINK).origin

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const player = (env: ContractEnv) => makeUser(db(env))
const subscriptions = (env: ContractEnv, uid: string) => sql(env, `select count(*) from public.push_subscriptions where user_id = :'uid'`, { uid })
const outbox = (env: ContractEnv, uid: string) => sql(env, `select count(*) from wm.push_outbox o
join public.push_subscriptions s on s.id = o.subscription_id where s.user_id = :'uid'`, { uid })
// Une auction_won pour uid, posée par psql (le trigger remplit l'outbox) ; « Tu as remporté Chat pour 100 wikibidous ».
const won = (env: ContractEnv, uid: string) => sql(env, `insert into public.notifications (user_id, type, data)
values (:'uid', 'auction_won', jsonb_build_object('auction_id', gen_random_uuid(), 'card_title', 'Chat', 'amount', 100))`, { uid })
const cronPush = (base: string, secret?: string) =>
  fetch(`${base}/api/cron/push`, { method: 'POST', headers: secret === undefined ? {} : { 'x-cron-secret': secret } })

function keys(): { ua: ReturnType<typeof createECDH>; auth: Buffer; keys: { p256dh: string; auth: string } } {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = randomBytes(16)
  return { ua, auth, keys: { p256dh: ua.getPublicKey('base64url'), auth: auth.toString('base64url') } }
}

// Origine du banc dans la liste blanche : de la configuration (M4b-12).
function allowSink(env: ContractEnv): void {
  sql(env, `update wm.config set value = jsonb_set(value, '{origins}', (value -> 'origins') || to_jsonb(:'o'::text))
where key = 'push_origins' and not (value -> 'origins') ? :'o'`, { o: SINK_ORIGIN })
}

// Joueur neuf, abonné à un endpoint neuf, types activés par la route.
async function subscriber(env: ContractEnv, types: string[], endpoint = `${PUSH_SINK}/${randomUUID()}`): Promise<Subscriber> {
  allowSink(env)
  const user = player(env)
  const k = keys()
  await ok(await send(env, 'POST', SUBSCRIBE, user.uid, { endpoint, keys: k.keys }), Ok)
  const { vapid_public } = await ok(await send(env, 'POST', SETTINGS, user.uid, { push_types: types }), Prefs)
  return { ...user, endpoint, ua: k.ua, auth: k.auth, vapid_public }
}

const deliveries = async (endpoint: string): Promise<Delivery[]> =>
  ((await (await fetch(endpoint)).json()) as { deliveries: Delivery[] }).deliveries

// Relu toutes les 100 ms jusqu'à une livraison, au plus `ms`.
async function delivered(endpoint: string, ms = 5_000): Promise<Delivery[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const list = await deliveries(endpoint)
    if (list.length || Date.now() >= deadline) return list
    await sleep(100)
  }
}

const decrypt = (s: Subscriber, d: Delivery) => decryptPush(Buffer.from(d.body_b64, 'base64'), s.ua, s.auth)

export const pushSubscribe: RouteSpec = {
  method: 'POST',
  path: SUBSCRIBE,
  source: 'D§7.9',
  confidence: 'ajouté',
  cases: [
    noSession('POST', SUBSCRIBE),
    {
      name: '{ endpoint du faux service, keys } → { ok: true }, une ligne (psql)',
      run: async (env) => {
        allowSink(env)
        const { uid } = player(env)
        assert.deepEqual(await ok(await send(env, 'POST', SUBSCRIBE, uid, { endpoint: `${PUSH_SINK}/${randomUUID()}`, keys: keys().keys }), Ok), { ok: true })
        assert.equal(subscriptions(env, uid), '1')
      },
    },
    {
      name: 'p256dh de 64 octets (zod), puis hors de la courbe (pre) → 400 « Abonnement push invalide », aucune ligne',
      run: async (env) => {
        allowSink(env)
        const { uid } = player(env)
        const endpoint = `${PUSH_SINK}/${randomUUID()}`
        for (const p256dh of [randomBytes(64).toString('base64url'), `B${'A'.repeat(86)}`]) {
          await refused(await send(env, 'POST', SUBSCRIBE, uid, { endpoint, keys: { ...keys().keys, p256dh } }), 400, 'Abonnement push invalide', 'invalid_request')
        }
        assert.equal(subscriptions(env, uid), '0')
      },
    },
    {
      name: 'Review Focus, endpoint hostile qui passe zod (@, \\, https: sans //) → 400 « Service de notifications non pris en charge », aucune ligne',
      run: async (env) => {
        const { uid } = player(env)
        for (const endpoint of ['https://fcm.googleapis.com@evil.example/x', 'https://evil.example\\.notify.windows.com/x',
          'https:evil.example/x://a.notify.windows.com/']) {
          await refused(await send(env, 'POST', SUBSCRIBE, uid, { endpoint, keys: keys().keys }), 400, UNSUPPORTED, 'invalid_request')
        }
        assert.equal(subscriptions(env, uid), '0')
      },
    },
    {
      name: 'endpoint au \\0 ou à la demi-paire UTF-16 dans le chemin (pgText) → 400 « Abonnement push invalide », aucune ligne (psql)',
      run: async (env) => {
        allowSink(env)
        const { uid } = player(env)
        for (const endpoint of [`${PUSH_SINK}/a\u0000b`, `${PUSH_SINK}/a\ud800b`]) {
          await refused(await send(env, 'POST', SUBSCRIBE, uid, { endpoint, keys: keys().keys }), 400, 'Abonnement push invalide', 'invalid_request')
        }
        assert.equal(subscriptions(env, uid), '0')
      },
    },
    {
      name: 'même Idempotency-Key deux fois, la seconde avec un autre endpoint → corps identiques, seul le premier enregistré (psql)',
      run: async (env) => {
        allowSink(env)
        const { uid } = player(env)
        const [key, first, second] = [idem(), `${PUSH_SINK}/${randomUUID()}`, `${PUSH_SINK}/${randomUUID()}`]
        const body = await ok(await send(env, 'POST', SUBSCRIBE, uid, { endpoint: first, keys: keys().keys }, key), Ok)
        assert.deepEqual(await ok(await send(env, 'POST', SUBSCRIBE, uid, { endpoint: second, keys: keys().keys }, key), Ok), body)
        assert.equal(sql(env, `select string_agg(endpoint, ',') from public.push_subscriptions where user_id = :'uid'`, { uid }), first)
      },
    },
    {
      name: 'D:1083, push reçu par after() : une demande d\'ami → une livraison, aes128gcm, JWT VAPID valide, charge déchiffrée exacte, sans cron',
      run: async (env) => {
        const alice = await subscriber(env, ['friend_request'])
        const bob = player(env)
        await ok(await send(env, 'POST', '/api/friends', bob.uid, { addressee_id: alice.uid }), Friendship)
        const list = await delivered(alice.endpoint)
        assert.equal(list.length, 1)
        const [d] = list
        assert.deepEqual([d.headers['content-encoding'], d.headers.ttl, d.headers.urgency], ['aes128gcm', '86400', 'normal'])
        const now = Math.floor(Date.now() / 1000)
        const jwt = verifyVapid(d.headers.authorization, alice.vapid_public)
        assert.deepEqual([jwt.aud, jwt.sub], [SINK_ORIGIN, 'mailto:push@example.invalid'])
        assert.ok(jwt.exp > now && jwt.exp <= now + 86_400, `exp ${jwt.exp}`)
        const id = sql(env, `select id from public.notifications where user_id = :'uid' and type = 'friend_request'`, { uid: alice.uid })
        assert.deepEqual(JSON.parse(decrypt(alice, d)),
          { title: brand.name, body: `${bob.username} veut devenir ton ami`, url: '/friends', tag: id })
      },
    },
    {
      name: 'type non activé : une demande d\'ami vers un abonné à auction_won seul → aucune livraison en 2 s, aucune ligne d\'outbox',
      run: async (env) => {
        const dave = await subscriber(env, ['auction_won'])
        const carol = player(env)
        await ok(await send(env, 'POST', '/api/friends', carol.uid, { addressee_id: dave.uid }), Friendship)
        assert.deepEqual(await delivered(dave.endpoint, 2_000), [])
        assert.equal(outbox(env, dave.uid), '0')
      },
    },
    {
      name: 'le contenu d\'un message n\'est jamais dans la charge : « secret 42 » → « <Bob> t\'a écrit », tag dm:<bob>',
      run: async (env) => {
        const alice = await subscriber(env, ['chat_message'])
        const bob = player(env)
        befriend(env, bob.uid, alice.uid)
        await created(await send(env, 'POST', `/api/chat/${alice.uid}`, bob.uid, { content: 'secret 42' }), z.object({ message: z.object({ id: z.uuid() }) }))
        const list = await delivered(alice.endpoint)
        assert.equal(list.length, 1)
        const text = decrypt(alice, list[0])
        assert.ok(!text.includes('secret'), text)
        assert.deepEqual(JSON.parse(text), { title: brand.name, body: `${bob.username} t'a écrit`, url: `/dms?with=${bob.uid}`, tag: `dm:${bob.uid}` })
      },
    },
  ],
}

export const notificationSettingsGet: RouteSpec = {
  method: 'GET',
  path: SETTINGS,
  source: 'D§7.9',
  confidence: 'ajouté',
  cases: [
    noSession('GET', SETTINGS),
    {
      name: '→ { push_types: [], vapid_public } (87 caractères base64url, M4b-14)',
      run: async (env) => {
        const { uid } = player(env)
        assert.deepEqual((await ok(await send(env, 'GET', SETTINGS, uid), Prefs)).push_types, [])
      },
    },
  ],
}

export const notificationSettingsPost: RouteSpec = {
  method: 'POST',
  path: SETTINGS,
  source: 'D§7.9',
  confidence: 'ajouté',
  cases: [
    {
      name: '[friend_request, auction_won] → triés, avec vapid_public ; [nope] → 400 « Type de notification inconnu »',
      run: async (env) => {
        const { uid } = player(env)
        const res = await ok(await send(env, 'POST', SETTINGS, uid, { push_types: ['friend_request', 'auction_won'] }), Prefs)
        assert.deepEqual(res.push_types, ['auction_won', 'friend_request'])
        await refused(await send(env, 'POST', SETTINGS, uid, { push_types: ['nope'] }), 400, 'Type de notification inconnu', 'invalid_request')
      },
    },
    {
      name: 'même Idempotency-Key deux fois, la seconde avec d\'autres types → corps identiques',
      run: async (env) => {
        const { uid } = player(env)
        const key = idem()
        const first = await ok(await send(env, 'POST', SETTINGS, uid, { push_types: ['friend_request'] }, key), Prefs)
        assert.deepEqual(await ok(await send(env, 'POST', SETTINGS, uid, { push_types: ['auction_won'] }, key), Prefs), first)
      },
    },
  ],
}

export const cronPushSpec: RouteSpec = {
  method: 'POST',
  path: '/api/cron/push',
  source: 'D§7.9',
  confidence: 'ajouté',
  cases: [
    {
      name: 'push par le cron : une auction_won posée par psql → { sent: 1, gone: 0, failed: 0 }, la livraison déchiffrée « Tu as remporté … »',
      run: async (env) => {
        // Le dernier appel HTTP de subscriber() est sans push : aucun after() ne réserve la ligne.
        const s = await subscriber(env, ['auction_won'])
        sql(env, 'delete from wm.push_outbox where true')
        won(env, s.uid)
        assert.equal(outbox(env, s.uid), '1')
        assert.deepEqual(await ok(await cronPush(env.plain, CRON_SECRET), Counts), { sent: 1, gone: 0, failed: 0 })
        const list = await deliveries(s.endpoint)
        assert.equal(list.length, 1)
        assert.equal(JSON.parse(decrypt(s, list[0])).body, 'Tu as remporté Chat pour 100 wikibidous')
      },
    },
    {
      name: '410 du service → { sent: 0, gone: 1, failed: 0 }, l\'abonnement disparu (psql)',
      run: async (env) => {
        const erin = await subscriber(env, ['auction_won'], `${PUSH_SINK}/gone/${randomUUID()}`)
        sql(env, 'delete from wm.push_outbox where true')
        won(env, erin.uid)
        assert.deepEqual(await ok(await cronPush(env.plain, CRON_SECRET), Counts), { sent: 0, gone: 1, failed: 0 })
        assert.equal(subscriptions(env, erin.uid), '0')
      },
    },
    {
      name: 'sans secret, puis un mauvais secret → 401 cron_unauthorized',
      run: async ({ plain }) => {
        for (const secret of [undefined, `${CRON_SECRET}x`]) await failed(await cronPush(plain, secret), 401, 'cron_unauthorized')
      },
    },
    {
      name: 'serveur à porte, sans cookie de porte, bon secret → 200',
      run: async ({ gated }) => void (await ok(await cronPush(gated, CRON_SECRET), Counts)),
    },
  ],
}

export const pushUnsubscribe: RouteSpec = {
  method: 'DELETE',
  path: SUBSCRIBE,
  source: 'D§7.9',
  confidence: 'ajouté',
  cases: [
    noSession('DELETE', SUBSCRIBE),
    {
      name: 'l\'endpoint de l\'abonné → { ok: true }, sa ligne disparue (psql) ; un endpoint inconnu → { ok: true }',
      run: async (env) => {
        const s = await subscriber(env, [])
        assert.deepEqual(await ok(await send(env, 'DELETE', SUBSCRIBE, s.uid, { endpoint: s.endpoint }), Ok), { ok: true })
        assert.equal(subscriptions(env, s.uid), '0')
        assert.deepEqual(await ok(await send(env, 'DELETE', SUBSCRIBE, s.uid, { endpoint: `${PUSH_SINK}/${randomUUID()}` }), Ok), { ok: true })
      },
    },
    {
      name: 'endpoint au \\0 ou à la demi-paire UTF-16 dans le chemin (pgText) → 400 « Abonnement push invalide », la ligne de l\'abonné gardée',
      run: async (env) => {
        const s = await subscriber(env, [])
        for (const endpoint of [`${PUSH_SINK}/a\u0000b`, `${PUSH_SINK}/a\ud800b`]) {
          await refused(await send(env, 'DELETE', SUBSCRIBE, s.uid, { endpoint }), 400, 'Abonnement push invalide', 'invalid_request')
        }
        assert.equal(subscriptions(env, s.uid), '1')
      },
    },
    {
      name: 'même Idempotency-Key deux fois, la ligne recréée entre-temps (psql) → { ok: true } les deux fois, la ligne recréée gardée',
      run: async (env) => {
        const s = await subscriber(env, [])
        const key = idem()
        assert.deepEqual(await ok(await send(env, 'DELETE', SUBSCRIBE, s.uid, { endpoint: s.endpoint }, key), Ok), { ok: true })
        assert.equal(subscriptions(env, s.uid), '0')
        sql(env, `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (:'uid', :'e', 'p', 'k')`, { uid: s.uid, e: s.endpoint })
        assert.deepEqual(await ok(await send(env, 'DELETE', SUBSCRIBE, s.uid, { endpoint: s.endpoint }, key), Ok), { ok: true })
        assert.equal(subscriptions(env, s.uid), '1')
      },
    },
  ],
}

export const push: RouteSpec[] = [pushSubscribe, notificationSettingsGet, notificationSettingsPost, cronPushSpec, pushUnsubscribe]
