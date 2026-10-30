import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, created, failed, giveCards, idem, Iso, makeUser, noSession, ok, psql, refused, send } from '../users.ts'
import { befriend } from './friends.ts'

// Formes strictes (comme battles.ts) : une clé en plus ferait échouer le cas au lieu de disparaître avant le deepEqual.
const Who = z.strictObject({ id: z.uuid(), username: z.string() })
const Guild = z.strictObject({ id: z.uuid(), name: z.string(), description: z.string().nullable(), leader_id: z.uuid().nullable(), created_at: Iso })
const Membership = z.strictObject({ guild_id: z.uuid(), user_id: z.uuid(), role: z.enum(['leader', 'member']), joined_at: Iso })
const Invite = z.strictObject({ guild_id: z.uuid(), guild_name: z.string(), inviter_username: z.string(), created_at: Iso })
const State = z.strictObject({ guild: Guild.nullable(), membership: Membership.nullable(), member_count: z.int().min(0), invites: z.array(Invite) })
const Ok = z.strictObject({ ok: z.literal(true) })
const Member = z.strictObject({
  user_id: z.uuid(), id: z.uuid(), username: z.string(), profile: z.strictObject({ username: z.string() }),
  user: z.strictObject({ username: z.string() }), role: z.enum(['leader', 'member']), joined_at: Iso,
})
const Members = z.strictObject({ members: z.array(Member), hasMore: z.boolean() })
const Message = z.strictObject({
  id: z.uuid(), user_id: z.uuid(), content: z.string(), created_at: Iso, username: z.string(),
  user: z.strictObject({ username: z.string() }), profile: z.strictObject({ username: z.string() }),
})
const Sent = z.strictObject({ message: Message })
const Messages = z.strictObject({ messages: z.array(Message) })
const Wish = z.strictObject({
  id: z.uuid(), user_id: z.uuid(), card: z.object({ id: z.uuid(), wikipedia_title: z.string() }).loose(), created_at: Iso,
  can_donate: z.boolean(), recipient_received_today: z.boolean(), user: Who, recipient: Who,
  my_copies: z.array(z.strictObject({ id: z.uuid(), count: z.int().min(1), is_shiny: z.boolean() })),
})
const Home = z.strictObject({
  my_wishlist: Wish.nullable(), wishlists: z.array(Wish), received_donation_today: z.boolean(),
  weekly_karma_donors: z.array(z.strictObject({ user_id: z.uuid(), username: z.string(), karma: z.int(), karma_this_week: z.int(), donations_this_week: z.int() })),
})
const Wished = z.strictObject({ wishlist: z.strictObject({ id: z.uuid(), user_id: z.uuid(), card_id: z.uuid(), created_at: Iso }) })
const Donated = z.strictObject({ ok: z.literal(true), wishlist_id: z.uuid() })

const NO_GUILD = 'Tu n\'es dans aucune guilde'
const NOT_LEADER = 'Seul le chef de la guilde peut faire cela'

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const player = (env: ContractEnv) => makeUser(db(env))
const post = (env: ContractEnv, path: string, uid: string, body?: unknown, headers?: Record<string, string>) => send(env, 'POST', `/api/guilds${path}`, uid, body, headers)
const get = (env: ContractEnv, path: string, uid: string) => api(env, `/api/guilds${path}`, { uid })

// Guilde de `leader` avec ses `members` (amitiés, création, invitations, adhésions par psql) ; renvoie son id.
export function guildWith(env: ContractEnv, leader: string, members: string[] = []): string {
  const id = sql(env, `select wm.guild_create(:'l', 'g' || substr(gen_random_uuid()::text, 1, 12)) -> 'guild' ->> 'id'`, { l: leader })
  for (const m of members) {
    befriend(env, leader, m)
    sql(env, `select wm.guild_invite(:'l', :'m')`, { l: leader, m })
    sql(env, `select wm.guild_join(:'m', :'g')`, { m, g: id })
  }
  return id
}
const leaderOf = (env: ContractEnv, g: string) => sql(env, `select leader_id from public.guilds where id = :'g'`, { g })
const memberOf = (env: ContractEnv, uid: string) => sql(env, `select guild_id from public.guild_members where user_id = :'u'`, { u: uid })
const wish = (env: ContractEnv, uid: string, copy: string) =>
  sql(env, `select wm.guild_wish_set(:'u', (select card_id from public.user_cards where id = :'c')) -> 'wishlist' ->> 'id'`, { u: uid, c: copy })
// Un joueur de plus dans la guilde de `leader`, avec sa guilde.
const guildOf = (env: ContractEnv, n = 1) => {
  const [leader, ...rest] = Array.from({ length: n + 1 }, () => player(env))
  return { leader, rest, guild: guildWith(env, leader.uid, rest.map((r) => r.uid)) }
}
// config.guild.max_members posé, restauré par l'appelant.
const setMax = (env: ContractEnv, n: string) => sql(env, `update wm.config set value = value || jsonb_build_object('max_members', :'n'::int) where key = 'guild'`, { n })

const spec = (method: RouteSpec['method'], path: string, cases: RouteSpec['cases'], url = path.replace('{guildId}', randomUUID())): RouteSpec => ({
  method, path: `/api/guilds${path === '/' ? '' : path}`, source: 'R§3.10', confidence: 'prob.',
  cases: [noSession(method, `/api/guilds${url === '/' ? '' : url}`), ...cases],
})

export const guilds: RouteSpec[] = [
  spec('GET', '/', [
    {
      name: 'sans guilde → State à guild nul, member_count 0, invites []',
      run: async (env) => {
        const s = await ok(await get(env, '', player(env).uid), State)
        assert.deepEqual(s, { guild: null, membership: null, member_count: 0, invites: [] })
      },
    },
    {
      name: 'invité → invites d\'un élément (nom de guilde, pseudo de l\'inviteur)',
      run: async (env) => {
        const { leader, guild } = guildOf(env, 0)
        const me = player(env)
        befriend(env, leader.uid, me.uid)
        sql(env, `select wm.guild_invite(:'l', :'m')`, { l: leader.uid, m: me.uid })
        const s = await ok(await get(env, '', me.uid), State)
        assert.equal(s.guild, null)
        assert.deepEqual(s.invites.map((i) => [i.guild_id, i.inviter_username]), [[guild, leader.username]])
      },
    },
  ]),
  spec('POST', '/', [
    {
      name: '201 State (chef, 1 membre) ; nom de 41 caractères → 400 exact ; caractère nul → 400 « Caractère invalide »',
      run: async (env) => {
        const me = player(env)
        assert.equal((await created(await post(env, '', me.uid, { name: 'Les Sages', description: 'x' }), State)).member_count, 1)
        const s = await ok(await get(env, '', me.uid), State)
        assert.deepEqual([s.membership?.role, s.guild?.leader_id, s.member_count], ['leader', me.uid, 1])
        const other = player(env)
        await refused(await post(env, '', other.uid, { name: 'a'.repeat(41) }), 400, 'Un nom de guilde fait au plus 40 caractères', 'invalid_request')
        await refused(await post(env, '', other.uid, { name: 'a\u0000' }), 400, 'Caractère invalide', 'invalid_request')
      },
    },
    {
      name: 'déjà membre → 409 exact ; même clé deux fois → corps identiques, une seule guilde',
      run: async (env) => {
        const { leader } = guildOf(env, 0)
        await refused(await post(env, '', leader.uid, { name: 'Autre' }), 409, 'Tu fais déjà partie d\'une guilde')
        const me = player(env)
        const key = idem()
        const first = await created(await post(env, '', me.uid, { name: 'Une' }, key), State)
        assert.deepEqual(await created(await post(env, '', me.uid, { name: 'Une' }, key), State), first)
        assert.equal(sql(env, `select count(*) from public.guilds where leader_id = :'u'`, { u: me.uid }), '1')
      },
    },
  ]),
  spec('POST', '/join', [
    {
      name: 'invité → 200 State ; sans invitation → 403 exact ; plein (max_members posé) → 409 exact',
      run: async (env) => {
        const { leader, guild } = guildOf(env, 0)
        const [me, stranger] = [player(env), player(env)]
        befriend(env, leader.uid, me.uid)
        sql(env, `select wm.guild_invite(:'l', :'m')`, { l: leader.uid, m: me.uid })
        await refused(await post(env, '/join', stranger.uid, { guild_id: guild }), 403, 'Aucune invitation de cette guilde', 'FORBIDDEN')
        const max = sql(env, `select value ->> 'max_members' from wm.config where key = 'guild'`)
        setMax(env, '1')
        try {
          await refused(await post(env, '/join', me.uid, { guild_id: guild }), 409, 'Cette guilde est pleine')
        } finally {
          setMax(env, max)
        }
        const s = await ok(await post(env, '/join', me.uid, { guild_id: guild }), State)
        assert.deepEqual([s.guild?.id, s.membership?.role, s.member_count, s.invites], [guild, 'member', 2, []])
      },
    },
  ]),
  spec('DELETE', '/invites/{guildId}', [
    {
      name: 'refus → Ok ; abc → 400 invalid_request ; de nouveau → 404 exact',
      run: async (env) => {
        const { leader, guild } = guildOf(env, 0)
        const me = player(env)
        befriend(env, leader.uid, me.uid)
        sql(env, `select wm.guild_invite(:'l', :'m')`, { l: leader.uid, m: me.uid })
        await ok(await send(env, 'DELETE', `/api/guilds/invites/${guild}`, me.uid), Ok)
        await failed(await send(env, 'DELETE', '/api/guilds/invites/abc', me.uid), 400, 'invalid_request')
        await refused(await send(env, 'DELETE', `/api/guilds/invites/${guild}`, me.uid), 404, 'Aucune invitation de cette guilde')
      },
    },
  ]),
  spec('GET', '/home', [
    {
      name: 'Home : mon souhait à part, celui d\'un autre avec mes copies (G6) ; sans guilde → 404 exact',
      run: async (env) => {
        const { leader, rest: [a] } = guildOf(env)
        const [copy] = giveCards(db(env), a.uid, 'C')
        const mine = wish(env, leader.uid, copy)
        const h = await ok(await get(env, '/home', a.uid), Home)
        assert.equal(h.my_wishlist, null)
        assert.deepEqual(h.wishlists.map((w) => [w.id, w.user.username, w.can_donate, w.my_copies.map((c) => c.id)]), [[mine, leader.username, true, [copy]]])
        await refused(await get(env, '/home', player(env).uid), 404, NO_GUILD)
      },
    },
  ]),
  spec('PUT', '/wishlist', [
    {
      name: '{ wishlist } strict à quatre clés ; carte inconnue → 404 exact ; sans guilde → 404 exact',
      run: async (env) => {
        const { leader } = guildOf(env, 0)
        const [card] = sql(env, `select id from public.cards order by wikipedia_title limit 1`).split('\n')
        const w = await ok(await send(env, 'PUT', '/api/guilds/wishlist', leader.uid, { card_id: card }), Wished)
        assert.deepEqual([w.wishlist.user_id, w.wishlist.card_id], [leader.uid, card])
        await refused(await send(env, 'PUT', '/api/guilds/wishlist', leader.uid, { card_id: randomUUID() }), 404, 'Carte introuvable')
        await refused(await send(env, 'PUT', '/api/guilds/wishlist', player(env).uid, { card_id: card }), 404, NO_GUILD)
      },
    },
  ]),
  spec('DELETE', '/wishlist', [
    {
      name: 'retrait → Ok, puis 404 exact ; sans guilde → 404 « aucune guilde » (C6)',
      run: async (env) => {
        const { leader } = guildOf(env, 0)
        const [copy] = giveCards(db(env), leader.uid, 'C')
        wish(env, leader.uid, copy)
        await ok(await send(env, 'DELETE', '/api/guilds/wishlist', leader.uid), Ok)
        await refused(await send(env, 'DELETE', '/api/guilds/wishlist', leader.uid), 404, 'Tu ne demandes aucune carte')
        await refused(await send(env, 'DELETE', '/api/guilds/wishlist', player(env).uid), 404, NO_GUILD)
      },
    },
  ]),
  spec('POST', '/wishlist/donate', [
    {
      name: 'don → Donated, copie au receveur ; second don du jour → 409 exact ; copie d\'un autre → 403 42501 ; invariants intacts',
      run: async (env) => {
        const { leader, rest: [donor, other] } = guildOf(env, 2)
        const [wanted] = giveCards(db(env), leader.uid, 'C')
        const w = wish(env, leader.uid, wanted)
        const [mine] = giveCards(db(env), donor.uid, 'C')
        const [theirs] = giveCards(db(env), other.uid, 'C')
        await refused(await post(env, '/wishlist/donate', donor.uid, { wishlist_id: w, user_card_id: theirs }), 403, 'Vous ne possédez pas cette carte', '42501')
        const d = await ok(await post(env, '/wishlist/donate', donor.uid, { wishlist_id: w, user_card_id: mine }), Donated)
        assert.equal(d.wishlist_id, w)
        assert.equal(sql(env, `select user_id from public.user_cards where id = :'c'`, { c: mine }), leader.uid)
        const again = wish(env, leader.uid, wanted)
        await refused(await post(env, '/wishlist/donate', other.uid, { wishlist_id: again, user_card_id: theirs }), 409, 'Ce membre a déjà reçu un don aujourd\'hui')
        assert.equal(sql(env, `select wm.check_invariants()`), '[]')
      },
    },
    {
      name: 'même clé deux fois → corps identiques, un seul don ; sans guilde → 404 exact',
      run: async (env) => {
        const { leader, rest: [donor] } = guildOf(env)
        const [wanted] = giveCards(db(env), leader.uid, 'C')
        const w = wish(env, leader.uid, wanted)
        const [mine] = giveCards(db(env), donor.uid, 'C')
        const key = idem()
        const body = { wishlist_id: w, user_card_id: mine }
        const first = await ok(await post(env, '/wishlist/donate', donor.uid, body, key), Donated)
        assert.deepEqual(await ok(await post(env, '/wishlist/donate', donor.uid, body, key), Donated), first)
        assert.equal(sql(env, `select count(*) from public.guild_donations where wishlist_id = :'w'`, { w }), '1')
        const w2 = wish(env, leader.uid, wanted)
        await refused(await post(env, '/wishlist/donate', player(env).uid, { wishlist_id: w2, user_card_id: randomUUID() }), 404, NO_GUILD)
      },
    },
  ]),
  spec('GET', '/members', [
    {
      name: 'Members, chef d\'abord ; ?limit=1 → 1 élément et hasMore ; ?limit=-1 → 400 invalid_request ; sans guilde → 404 exact',
      run: async (env) => {
        const { leader, rest: [a] } = guildOf(env)
        const all = await ok(await get(env, '/members', a.uid), Members)
        assert.deepEqual([all.members.map((m) => m.user_id), all.hasMore], [[leader.uid, a.uid], false])
        const one = await ok(await get(env, '/members?limit=1', a.uid), Members)
        assert.deepEqual([one.members.length, one.hasMore], [1, true])
        await failed(await get(env, '/members?limit=-1', a.uid), 400, 'invalid_request')
        await refused(await get(env, '/members', player(env).uid), 404, NO_GUILD)
      },
    },
  ]),
  spec('POST', '/invite', [
    {
      name: 'ami → Ok et une invitation (psql) ; non-ami → 403 exact',
      run: async (env) => {
        const { leader, guild } = guildOf(env, 0)
        const [friend, stranger] = [player(env), player(env)]
        befriend(env, leader.uid, friend.uid)
        await ok(await post(env, '/invite', leader.uid, { user_id: friend.uid }), Ok)
        assert.equal(sql(env, `select count(*) from wm.guild_invites where guild_id = :'g' and user_id = :'u'`, { g: guild, u: friend.uid }), '1')
        await refused(await post(env, '/invite', leader.uid, { user_id: stranger.uid }), 403, 'Vous devez être amis pour inviter ce joueur', 'FORBIDDEN')
      },
    },
  ]),
  spec('POST', '/kick', [
    {
      name: 'chef → Ok, membre parti ; un membre → 403 exact',
      run: async (env) => {
        const { leader, rest: [a, b] } = guildOf(env, 2)
        await refused(await post(env, '/kick', a.uid, { user_id: b.uid }), 403, NOT_LEADER, 'FORBIDDEN')
        await ok(await post(env, '/kick', leader.uid, { user_id: b.uid }), Ok)
        assert.equal(memberOf(env, b.uid), '')
      },
    },
  ]),
  spec('POST', '/transfer-leadership', [
    {
      name: 'chef → Ok, leader_id changé ; vers soi → 400 exact',
      run: async (env) => {
        const { leader, rest: [a], guild } = guildOf(env)
        await refused(await post(env, '/transfer-leadership', leader.uid, { user_id: leader.uid }), 400, 'Tu es déjà le chef de la guilde', 'invalid_request')
        await ok(await post(env, '/transfer-leadership', leader.uid, { user_id: a.uid }), Ok)
        assert.equal(leaderOf(env, guild), a.uid)
      },
    },
  ]),
  spec('POST', '/leave', [
    {
      name: 'chef avec membres → 409 exact ; dernier membre → Ok, guilde absente',
      run: async (env) => {
        const { leader, rest: [a], guild } = guildOf(env)
        await refused(await post(env, '/leave', leader.uid), 409, 'Transmets d\'abord ton rôle de chef à un autre membre')
        await ok(await post(env, '/leave', a.uid), Ok)
        await ok(await post(env, '/leave', leader.uid), Ok)
        assert.equal(sql(env, `select count(*) from public.guilds where id = :'g'`, { g: guild }), '0')
      },
    },
  ]),
  spec('GET', '/chat', [
    {
      name: '{ messages } du plus ancien au plus récent ; sans guilde → 404 exact',
      run: async (env) => {
        const { leader, rest: [a] } = guildOf(env)
        await created(await post(env, '/chat', leader.uid, { content: 'un' }), Sent)
        await created(await post(env, '/chat', a.uid, { content: 'deux' }), Sent)
        const { messages } = await ok(await get(env, '/chat', a.uid), Messages)
        assert.deepEqual(messages.map((m) => [m.content, m.username]), [['un', leader.username], ['deux', a.username]])
        await refused(await get(env, '/chat', player(env).uid), 404, NO_GUILD)
      },
    },
  ]),
  spec('POST', '/chat', [
    {
      name: '201 { message } ; 1 001 caractères → 400 exact',
      run: async (env) => {
        const { leader } = guildOf(env, 0)
        const m = await created(await post(env, '/chat', leader.uid, { content: 'salut' }), Sent)
        assert.deepEqual([m.message.user_id, m.message.content], [leader.uid, 'salut'])
        await refused(await post(env, '/chat', leader.uid, { content: 'a'.repeat(1001) }), 400, 'Un message fait au plus 1 000 caractères', 'invalid_request')
      },
    },
    {
      name: 'Review Focus, seau partagé par HTTP : chat_burst à 2 → deux messages privés puis un de guilde → 429 sans code, retry_after entier, Retry-After égal',
      run: async (env) => {
        const { leader } = guildOf(env, 0)
        const peer = player(env)
        befriend(env, leader.uid, peer.uid)
        const burst = sql(env, `select value from wm.config where key = 'chat_burst'`)
        sql(env, `update wm.config set value = '{"count": 2, "window_s": 60}' where key = 'chat_burst'`)
        try {
          for (const content of ['p1', 'p2']) await created(await send(env, 'POST', `/api/chat/${peer.uid}`, leader.uid, { content }), z.looseObject({}))
          const res = await post(env, '/chat', leader.uid, { content: 'g1' })
          const body = await failed(res, 429)
          const after = z.int().min(1).max(60).parse(body.retry_after)
          assert.deepEqual(body, { error: 'Le site demande de ralentir', message: 'Le site demande de ralentir', retry_after: after })
          assert.equal(res.headers.get('retry-after'), String(after))
        } finally {
          sql(env, `update wm.config set value = :'burst' where key = 'chat_burst'`, { burst })
        }
      },
    },
    {
      name: 'Review Focus, ce que voit un autre joueur : un membre de H ne voit aucun id de G (message, souhait, membre, guilde) dans ses réponses',
      run: async (env) => {
        const g = guildOf(env)
        const h = guildOf(env, 0)
        const [copy] = giveCards(db(env), g.leader.uid, 'C')
        const w = wish(env, g.leader.uid, copy)
        const msg = (await created(await post(env, '/chat', g.leader.uid, { content: 'secret' }), Sent)).message.id
        await created(await post(env, '/chat', h.leader.uid, { content: 'autre' }), Sent)
        const text = (await Promise.all(['', '/home', '/members', '/chat'].map(async (p) => (await get(env, p, h.leader.uid)).text()))).join('\n')
        for (const id of [msg, w, g.guild, g.leader.uid, ...g.rest.map((r) => r.uid)]) assert.ok(!text.includes(id), `fuite de ${id}`)
      },
    },
  ]),
]
