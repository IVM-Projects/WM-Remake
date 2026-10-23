import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, created, failed, idem, Iso, makeUser, noSession, ok, psql, refused, send } from '../users.ts'
import { befriend } from './friends.ts'

// Formes strictes (B2, M4b-9) : une clé en plus ferait échouer le cas au lieu de disparaître avant le deepEqual.
const Message = z.strictObject({
  id: z.uuid(), sender_id: z.uuid(), recipient_id: z.uuid(), content: z.string(), read: z.boolean(), created_at: Iso,
})
const Conversation = z.strictObject({
  peer_id: z.uuid(), peer_username: z.string(), peer_avatar_url: z.string().nullable(), last_message: z.string(), last_message_at: Iso,
  unread_count: z.int(),
})
const Conversations = z.strictObject({ conversations: z.array(Conversation) })
const Thread = z.strictObject({
  messages: z.array(Message), peer: z.strictObject({ id: z.uuid(), username: z.string(), avatar_url: z.string().nullable() }), isFriend: z.boolean(),
})
const Sent = z.strictObject({ message: Message })

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const player = (env: ContractEnv) => makeUser(db(env))
const at = (peerId: string) => `/api/chat/${peerId}`
const post = (env: ContractEnv, uid: string, peerId: string, body: unknown, headers?: Record<string, string>) =>
  send(env, 'POST', at(peerId), uid, body, headers)
// Date fixe, à la seconde s : comparée en ISO, quel que soit le fuseau de la session qui sérialise.
const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
// Message posé par SQL à la date T(s) ; renvoie son id.
const say = (env: ContractEnv, from: string, to: string, content: string, s: number, read = false) =>
  sql(env, `insert into public.chat_messages (sender_id, recipient_id, content, read, created_at)
values (:'from', :'to', :'content', :'read', :'at') returning id`, { from, to, content, read: String(read), at: T(s) })
const row = (m: z.infer<typeof Message>) => [m.id, m.sender_id, m.recipient_id, m.content, m.read, new Date(m.created_at).toISOString()]
const contents = (env: ContractEnv, from: string) =>
  sql(env, `select coalesce(string_agg(content, ',' order by created_at), '') from public.chat_messages where sender_id = :'from'`, { from })

export const chatList: RouteSpec = {
  method: 'GET',
  path: '/api/chat',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/chat'),
    {
      name: 'A a écrit à B et reçu de C (psql) → deux conversations, la plus récente d\'abord, unread_count exact ; celles de deux autres absentes',
      run: async (env) => {
        const [a, b, c, x, y] = Array.from({ length: 5 }, () => player(env))
        say(env, a.uid, b.uid, 'b1', 1)
        say(env, c.uid, a.uid, 'c1', 2, true)
        say(env, c.uid, a.uid, 'c2', 3)
        say(env, c.uid, a.uid, 'c3', 4)
        say(env, x.uid, y.uid, 'ailleurs', 5)
        const { conversations } = await ok(await api(env, '/api/chat', { uid: a.uid }), Conversations)
        assert.deepEqual(conversations.map((r) => ({ ...r, last_message_at: new Date(r.last_message_at).toISOString() })), [
          { peer_id: c.uid, peer_username: c.username, peer_avatar_url: null, last_message: 'c3', last_message_at: T(4), unread_count: 2 },
          { peer_id: b.uid, peer_username: b.username, peer_avatar_url: null, last_message: 'b1', last_message_at: T(1), unread_count: 0 },
        ])
      },
    },
  ],
}

export const chatThread: RouteSpec = {
  method: 'GET',
  path: '/api/chat/{peerId}',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('GET', at(randomUUID())),
    {
      name: 'peerId abc → 400 « UUID invalide » (zod) ; uuid inconnu → 404 « Joueur introuvable »',
      run: async (env) => {
        const { uid } = player(env)
        await refused(await api(env, at('abc'), { uid }), 400, 'UUID invalide', 'invalid_request')
        await refused(await api(env, at(randomUUID()), { uid }), 404, 'Joueur introuvable')
      },
    },
    {
      name: 'un ami → { messages } en ordre croissant, sans ceux d\'un autre couple, peer, isFriend vrai ; le GET ne marque rien lu (psql)',
      run: async (env) => {
        const [a, b, c] = [player(env), player(env), player(env)]
        befriend(env, a.uid, b.uid)
        const m2 = say(env, b.uid, a.uid, 'm2', 2)
        const m1 = say(env, a.uid, b.uid, 'm1', 1)
        say(env, c.uid, a.uid, 'ailleurs', 3)
        const r = await ok(await api(env, at(b.uid), { uid: a.uid }), Thread)
        assert.deepEqual({ ...r, messages: r.messages.map(row) }, {
          messages: [[m1, a.uid, b.uid, 'm1', false, T(1)], [m2, b.uid, a.uid, 'm2', false, T(2)]],
          peer: { id: b.uid, username: b.username, avatar_url: null }, isFriend: true,
        })
        assert.equal(sql(env, `select count(*) from public.chat_messages where read and :'a' in (sender_id, recipient_id)`, { a: a.uid }), '0')
      },
    },
    {
      name: 'ancien ami (amitié supprimée par psql) → 200, l\'historique, isFriend faux (M4b-9)',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        const friendship = befriend(env, a.uid, b.uid)
        const m = say(env, a.uid, b.uid, 'avant', 1)
        sql(env, `delete from public.friendships where id = :'friendship'`, { friendship })
        const r = await ok(await api(env, at(a.uid), { uid: b.uid }), Thread)
        assert.deepEqual([r.messages.map(row), r.isFriend], [[[m, a.uid, b.uid, 'avant', false, T(1)]], false])
      },
    },
  ],
}

export const chatSend: RouteSpec = {
  method: 'POST',
  path: '/api/chat/{peerId}',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('POST', at(randomUUID())),
    {
      name: 'un ami → 201 { message } (M4b-8), la ligne écrite ; une chat_message pour le pair (psql), une seule après deux envois',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        befriend(env, a.uid, b.uid)
        const { message } = await created(await post(env, a.uid, b.uid, { content: 'Salut' }), Sent)
        assert.deepEqual([message.sender_id, message.recipient_id, message.content, message.read], [a.uid, b.uid, 'Salut', false])
        assert.equal(sql(env, `select id from public.chat_messages where sender_id = :'a'`, { a: a.uid }), message.id)
        await created(await post(env, a.uid, b.uid, { content: 'Encore' }), Sent)
        assert.equal(contents(env, a.uid), 'Salut,Encore')
        assert.deepEqual(JSON.parse(sql(env, `select jsonb_agg(data) from public.notifications where user_id = :'b' and type = 'chat_message'`,
          { b: b.uid })), [{ user_id: a.uid, username: a.username }])
      },
    },
    {
      name: 'non-ami → 403 FORBIDDEN ; vide ou blancs seuls → 400 « Le message est vide » ; 2 001 é → 400 ; a\\0 → 400 « Caractère invalide » ; aucun message',
      run: async (env) => {
        const [a, b, stranger] = [player(env), player(env), player(env)]
        befriend(env, a.uid, b.uid)
        await refused(await post(env, a.uid, stranger.uid, { content: 'x' }), 403, 'Vous devez être amis pour vous écrire', 'FORBIDDEN')
        for (const content of ['', ' \n\t ']) await refused(await post(env, a.uid, b.uid, { content }), 400, 'Le message est vide', 'invalid_request')
        await refused(await post(env, a.uid, b.uid, { content: 'é'.repeat(2001) }), 400, 'Un message fait au plus 2 000 caractères', 'invalid_request')
        await refused(await post(env, a.uid, b.uid, { content: 'a\u0000' }), 400, 'Caractère invalide', 'invalid_request')
        assert.equal(contents(env, a.uid), '')
      },
    },
    {
      name: 'Review Focus, contenu aux bornes : 2 000 émojis → 201 ; « ␣␣hé␣␣ » → 201, gardé tel quel (psql)',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        befriend(env, a.uid, b.uid)
        for (const content of ['😀'.repeat(2000), '  hé  ']) {
          const { message } = await created(await post(env, a.uid, b.uid, { content }), Sent)
          assert.equal(message.content, content)
          assert.equal(sql(env, `select content = :'content' from public.chat_messages where id = :'id'`, { content, id: message.id }), 't')
        }
      },
    },
    {
      name: 'même Idempotency-Key deux fois, la seconde avec un autre contenu → corps identiques, une seule ligne',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        befriend(env, a.uid, b.uid)
        const key = idem()
        const first = await created(await post(env, a.uid, b.uid, { content: 'k1' }, key), Sent)
        assert.deepEqual(await created(await post(env, a.uid, b.uid, { content: 'k2' }, key), Sent), first)
        assert.equal(contents(env, a.uid), 'k1')
      },
    },
    {
      name: 'Review Focus, débit par HTTP : chat_burst à 2 (psql) → le 3ᵉ envoi 429 sans code, retry_after entier de 1 à 60, Retry-After égal (M4b-29)',
      run: async (env) => {
        const [a, b] = [player(env), player(env)]
        befriend(env, a.uid, b.uid)
        const burst = sql(env, `select value from wm.config where key = 'chat_burst'`)
        sql(env, `update wm.config set value = '{"count": 2, "window_s": 60}' where key = 'chat_burst'`)
        try {
          for (const content of ['d1', 'd2']) await created(await post(env, a.uid, b.uid, { content }), Sent)
          const res = await post(env, a.uid, b.uid, { content: 'd3' })
          const body = await failed(res, 429)
          const after = z.int().min(1).max(60).parse(body.retry_after)
          assert.deepEqual(body, { error: 'Le site demande de ralentir', message: 'Le site demande de ralentir', retry_after: after })
          assert.equal(res.headers.get('retry-after'), String(after))
          assert.equal(contents(env, a.uid), 'd1,d2')
        } finally {
          // Sans assertion : un échec ici masquerait celui du cas.
          sql(env, `update wm.config set value = :'burst' where key = 'chat_burst'`, { burst })
        }
      },
    },
  ],
}

export const chat: RouteSpec[] = [chatList, chatThread, chatSend]
