import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, failed, giveCards, idem, Iso, makeUser, noSession, ok, psql, refused, send } from '../users.ts'

// Joueur de wm.friend_search et des deux côtés de wm.friendship_json (R§3.7).
const UserHit = z.object({ id: z.uuid(), username: z.string(), avatar_url: z.string().nullable() })
// Objet Friendship de wm.friendship_json : la ligne de public.friendships et ses deux joueurs.
const Friendship = z.object({
  id: z.uuid(), status: z.enum(['pending', 'accepted']), requester_id: z.uuid(), addressee_id: z.uuid(),
  requester: UserHit, addressee: UserHit, created_at: Iso,
}).loose()
const One = z.object({ friendship: Friendship })

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const at = (id: string) => `/api/friends/${id}`
const player = (env: ContractEnv) => makeUser(db(env))
const who = (f: z.infer<typeof Friendship>) => [f.id, f.status, f.requester_id, f.requester.username, f.addressee_id, f.addressee.username]

// Ligne d'amitié posée par SQL ; renvoie son id.
const request = (env: ContractEnv, requester: string, addressee: string, status = 'pending') =>
  sql(env, `insert into public.friendships (requester_id, addressee_id, status) values (:'r', :'a', :'s') returning id`,
    { r: requester, a: addressee, s: status })
// Amis par SQL (aussi pour trades.ts).
export const befriend = (env: ContractEnv, a: string, b: string) => request(env, a, b, 'accepted')

// Échange en attente de `from` vers `to`, une copie C de `from` (wm.create_trade, entre amis) ; renvoie son id.
function trade(env: ContractEnv, from: string, to: string): string {
  const [copy] = giveCards(db(env), from, 'C')
  return sql(env, `select wm.create_trade(:'from', :'to', (select jsonb_agg(jsonb_build_object('user_card_id', id, 'card_id', card_id,
  'offered_by', user_id)) from public.user_cards where id = :'copy')) ->> 'id'`, { from, to, copy })
}

export const friendsList: RouteSpec = {
  method: 'GET',
  path: '/api/friends',
  source: 'R§3.7',
  confidence: 'conf.',
  cases: [
    noSession('GET', '/api/friends'),
    {
      name: 'une demande reçue, une envoyée et un ami → { friendships } de trois lignes, plus récente d\'abord, pseudos exacts ; celles des autres absentes',
      run: async (env) => {
        const [me, from, to, friend, x, y] = Array.from({ length: 6 }, () => player(env))
        const received = request(env, from.uid, me.uid)
        const sent = request(env, me.uid, to.uid)
        const accepted = befriend(env, friend.uid, me.uid)
        befriend(env, x.uid, y.uid)
        request(env, x.uid, from.uid)
        const { friendships } = await ok(await api(env, '/api/friends', { uid: me.uid }), z.object({ friendships: z.array(Friendship) }))
        assert.deepEqual(friendships.map(who), [
          [accepted, 'accepted', friend.uid, friend.username, me.uid, me.username],
          [sent, 'pending', me.uid, me.username, to.uid, to.username],
          [received, 'pending', from.uid, from.username, me.uid, me.username],
        ])
      },
    },
  ],
}

export const friendSearch: RouteSpec = {
  method: 'GET',
  path: '/api/friends/search',
  source: 'R§3.7',
  confidence: 'conf.',
  cases: [
    noSession('GET', '/api/friends/search?q=ab'),
    {
      name: 'q = les 6 premiers caractères d\'un pseudo unique → { users } avec ce joueur, sans le chercheur au même préfixe',
      run: async (env) => {
        const prefix = `f${randomUUID().slice(0, 5)}`
        const target = makeUser(db(env), { username: `${prefix}a${randomUUID().slice(-6)}` })
        const me = makeUser(db(env), { username: `${prefix}b${randomUUID().slice(-6)}` })
        const res = await ok(await api(env, `/api/friends/search?q=${target.username.slice(0, 6)}`, { uid: me.uid }), z.object({ users: z.array(UserHit) }))
        assert.deepEqual(res.users, [{ id: target.uid, username: target.username, avatar_url: null }])
      },
    },
    {
      name: 'q=a → 400 « La recherche demande au moins 2 caractères » ; sans q → la même 400 (SQL)',
      run: async (env) => {
        const { uid } = player(env)
        for (const path of ['/api/friends/search?q=a', '/api/friends/search']) {
          await refused(await api(env, path, { uid }), 400, 'La recherche demande au moins 2 caractères', 'invalid_request')
        }
      },
    },
  ],
}

const ask = (env: ContractEnv, uid: string, addressee_id: string, headers?: Record<string, string>) =>
  send(env, 'POST', '/api/friends', uid, { addressee_id }, headers)

export const friendRequest: RouteSpec = {
  method: 'POST',
  path: '/api/friends',
  source: 'R§3.7',
  confidence: 'conf.',
  cases: [
    noSession('POST', '/api/friends'),
    {
      name: '→ { friendship } pending ; une notification friend_request pour le destinataire (M4-12)',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const { friendship } = await ok(await ask(env, a.uid, b.uid), One)
        assert.deepEqual(who(friendship), [friendship.id, 'pending', a.uid, a.username, b.uid, b.username])
        assert.deepEqual(JSON.parse(sql(env, `select jsonb_agg(jsonb_build_object('type', type, 'data', data)) from public.notifications
where user_id = :'uid'`, { uid: b.uid })), [{ type: 'friend_request', data: { friendship_id: friendship.id, user_id: a.uid, username: a.username } }])
      },
    },
    {
      name: 'une seconde fois, ou en retour → 409 REQUEST_PENDING ; déjà amis → 409 ALREADY_FRIENDS ; soi-même → 400 ; inconnu → 404 ; {} → 400',
      run: async (env) => {
        const [a, b, c] = [player(env), player(env), player(env)]
        await ok(await ask(env, a.uid, b.uid), One)
        await refused(await ask(env, a.uid, b.uid), 409, 'Une demande d\'ami est déjà en attente', 'REQUEST_PENDING')
        await refused(await ask(env, b.uid, a.uid), 409, 'Une demande d\'ami est déjà en attente', 'REQUEST_PENDING')
        befriend(env, a.uid, c.uid)
        await refused(await ask(env, c.uid, a.uid), 409, 'Vous êtes déjà amis', 'ALREADY_FRIENDS')
        await refused(await ask(env, a.uid, a.uid), 400, 'Tu ne peux pas t\'ajouter toi-même en ami', 'invalid_request')
        await refused(await ask(env, a.uid, randomUUID()), 404, 'Joueur introuvable')
        await failed(await send(env, 'POST', '/api/friends', a.uid, {}), 400, 'invalid_request')
      },
    },
    {
      name: 'même Idempotency-Key deux fois → corps identiques, une seule ligne',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const key = idem()
        const first = await ok(await ask(env, a.uid, b.uid, key), One)
        assert.deepEqual(await ok(await ask(env, a.uid, b.uid, key), One), first)
        assert.equal(sql(env, `select count(*) from public.friendships where requester_id = :'uid'`, { uid: a.uid }), '1')
      },
    },
  ],
}

// Un joueur, deux demandes reçues et une envoyée (que « Tout accepter » laisse en attente) ; renvoie son « Tout accepter ».
function receivedTwice(env: ContractEnv) {
  const me = player(env)
  for (let i = 0; i < 2; i++) request(env, player(env).uid, me.uid)
  request(env, me.uid, player(env).uid)
  return async (headers?: Record<string, string>) => ok(await send(env, 'POST', '/api/friends/accept-all', me.uid, undefined, headers), z.unknown())
}

export const friendAcceptAll: RouteSpec = {
  method: 'POST',
  path: '/api/friends/accept-all',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('POST', '/api/friends/accept-all'),
    {
      name: 'deux demandes reçues → { accepted: 2 }, puis { accepted: 0 }',
      run: async (env) => {
        const acceptAll = receivedTwice(env)
        assert.deepEqual(await acceptAll(), { accepted: 2 })
        assert.deepEqual(await acceptAll(), { accepted: 0 })
      },
    },
    {
      name: 'même Idempotency-Key deux fois → { accepted: 2 } deux fois',
      run: async (env) => {
        const acceptAll = receivedTwice(env)
        const key = idem()
        assert.deepEqual(await acceptAll(key), { accepted: 2 })
        assert.deepEqual(await acceptAll(key), { accepted: 2 })
      },
    },
  ],
}

const act = (env: ContractEnv, uid: string, id: string, action: string, headers?: Record<string, string>) =>
  send(env, 'PATCH', at(id), uid, { action }, headers)

export const friendAction: RouteSpec = {
  method: 'PATCH',
  path: '/api/friends/{friendshipId}',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('PATCH', at(randomUUID())),
    {
      name: 'friendshipId=abc → 400 invalid_request',
      run: async (env) => void (await failed(await act(env, player(env).uid, 'abc', 'accept'), 400, 'invalid_request')),
    },
    {
      name: 'action = demi-paire UTF-16 seule (\\ud800) → 400 « Caractère invalide » (zod ; sinon PGRST102, donc 500)',
      run: async (env) => refused(await act(env, player(env).uid, randomUUID(), '\ud800'), 400, 'Caractère invalide', 'invalid_request'),
    },
    {
      name: 'le demandeur accepte → 403 FORBIDDEN « Seul le destinataire… » ; le destinataire accepte → { friendship } accepted',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const id = request(env, a.uid, b.uid)
        await refused(await act(env, a.uid, id, 'accept'), 403, 'Seul le destinataire peut accepter cette demande', 'FORBIDDEN')
        const { friendship } = await ok(await act(env, b.uid, id, 'accept'), One)
        assert.deepEqual(who(friendship), [id, 'accepted', a.uid, a.username, b.uid, b.username])
      },
    },
    {
      name: 'xyz → 400 « Action inconnue » (SQL, P11) ; un étranger → 404 ; refuser → { ok: true }, ligne supprimée ; même clé rejouée → { ok: true }',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const id = request(env, a.uid, b.uid)
        await refused(await act(env, b.uid, id, 'xyz'), 400, 'Action inconnue', 'invalid_request')
        await refused(await act(env, player(env).uid, id, 'decline'), 404, 'Demande d\'ami introuvable')
        const key = idem()
        assert.deepEqual(await ok(await act(env, b.uid, id, 'decline', key), z.unknown()), { ok: true })
        assert.equal(sql(env, `select count(*) from public.friendships where id = :'id'`, { id }), '0')
        assert.deepEqual(await ok(await act(env, b.uid, id, 'decline', key), z.unknown()), { ok: true })
      },
    },
    {
      name: 'accept, même Idempotency-Key deux fois → corps identiques',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const id = request(env, a.uid, b.uid)
        const key = idem()
        const first = await ok(await act(env, b.uid, id, 'accept', key), One)
        assert.deepEqual(await ok(await act(env, b.uid, id, 'accept', key), One), first)
      },
    },
  ],
}

export const friendRemove: RouteSpec = {
  method: 'DELETE',
  path: '/api/friends/{friendshipId}',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('DELETE', at(randomUUID())),
    {
      name: 'friendshipId=abc → 400 invalid_request',
      run: async (env) => void (await failed(await send(env, 'DELETE', at('abc'), player(env).uid), 400, 'invalid_request')),
    },
    {
      name: 'un ami, un échange en attente dans chaque sens → { ok: true } ; l\'amitié disparaît, les deux échanges passent à cancelled (M4-11)',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const id = befriend(env, a.uid, b.uid)
        const trades = [trade(env, a.uid, b.uid), trade(env, b.uid, a.uid)]
        assert.deepEqual(await ok(await send(env, 'DELETE', at(id), a.uid), z.unknown()), { ok: true })
        assert.equal(sql(env, `select count(*) from public.friendships where id = :'id'`, { id }), '0')
        assert.equal(sql(env, `select string_agg(status::text, ',') from public.trades where id = any (string_to_array(:'ids', ',')::uuid[])`,
          { ids: trades.join(',') }), 'cancelled,cancelled')
      },
    },
    {
      name: 'un étranger → 404 « Demande d\'ami introuvable » ; même Idempotency-Key deux fois → { ok: true } deux fois, sans 404',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const id = befriend(env, a.uid, b.uid)
        await refused(await send(env, 'DELETE', at(id), player(env).uid), 404, 'Demande d\'ami introuvable')
        const key = idem()
        for (let i = 0; i < 2; i++) assert.deepEqual(await ok(await send(env, 'DELETE', at(id), b.uid, undefined, key), z.unknown()), { ok: true })
      },
    },
  ],
}

export const friends: RouteSpec[] = [friendsList, friendSearch, friendRequest, friendAcceptAll, friendAction, friendRemove]
