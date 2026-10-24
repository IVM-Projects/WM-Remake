// Surface PostgREST directe de l'original sous RLS (R§3.1, R§3.3, R§3.4) : passerelle, clé publiable, JWT du joueur en Bearer.
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { accessToken, giveCards, makeUser, psql } from '../users.ts'
import { Card, CARD_COLUMNS } from './catalog.ts'
import { befriend } from './friends.ts'
import { listed, seller } from './market.ts'
import { pair, proposed } from './trades.ts'

const KEY = 'sb_publishable_test'

export function rest(env: ContractEnv, path: string, init: { method?: string; uid?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return fetch(`${env.backend.supabaseUrl}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      apikey: KEY,
      ...(init.uid && { authorization: `Bearer ${accessToken(env.backend, init.uid)}` }),
      'content-type': 'application/json',
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

async function status(res: Response, expected: number): Promise<unknown> {
  const text = await res.text()
  assert.equal(res.status, expected, text)
  return text === '' ? null : JSON.parse(text)
}

// Erreur PostgREST : { code, message, details, hint }.
async function pgError(res: Response, expected: number, code: string): Promise<void> {
  assert.equal((await status(res, expected) as { code: string }).code, code)
}

const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(env.backend.databaseUrl, query, vars)
const players = (env: ContractEnv) => [makeUser(env.backend.databaseUrl).uid, makeUser(env.backend.databaseUrl).uid] as const
const tag = (env: ContractEnv, uid: string, name: string) =>
  sql(env, `insert into public.tags (user_id, name) values (:'uid', :'name') returning id`, { uid, name })
const anyCards = (env: ContractEnv, n: number) => sql(env, `select id from public.cards order by id limit :'n'::int`, { n: String(n) }).split('\n')
const MINIMAL = { prefer: 'return=minimal' }
const REPRESENTATION = { prefer: 'return=representation', 'content-profile': 'public' }
// Sélection de rest/v1/auctions lue par les clients (R§3.5).
const AUCTION_COLUMNS = 'id,card_id,seller_id,base_amount,listing_base_amount,current_bid,current_bidder_id,final_price,status,end_at,settled_at,winner_id,created_at,snapshot_rarity,is_shiny'

const Profile = z.object({ id: z.uuid(), username: z.string() }).loose()
const Synced = z.strictObject({
  username: z.string(), avatar_url: z.string().nullable(), is_pro: z.boolean(), is_vip: z.boolean(), pack_cap: z.int(), packs_remaining: z.int(),
  packs_last_regen_at: z.string().nullable(), wikibidous_balance: z.int(), next_regen_at: z.string().nullable(),
})

const spec = (method: RouteSpec['method'], path: string, source: string, cases: RouteSpec['cases'],
  confidence: RouteSpec['confidence'] = 'conf.'): RouteSpec => ({ method, path: `rest/v1/${path}`, source, confidence, cases })
// Les échanges de ce joueur : le seul, toujours en attente (0005 n'accorde que select à authenticated : « aucun client n'y écrit »).
const onlyPending = (env: ContractEnv, uid: string, id: string) => assert.equal(sql(env, `select string_agg(id || ':' || status, ',')
from public.trades where :'uid' in (initiator_id, recipient_id)`, { uid }), `${id}:pending`)
// Deux amis, et deux messages de a à b par wm.chat_send : b a donc une chat_message non lue de a.
function chatted(env: ContractEnv) {
  const [a, b] = players(env)
  befriend(env, a, b)
  sql(env, `select wm.chat_send(:'a', :'b', 'm1'); select wm.chat_send(:'a', :'b', 'm2')`, { a, b })
  return [a, b] as const
}
// Messages de a à b en contenu:lu, puis la chat_message de a pour b.
const chatState = (env: ContractEnv, a: string, b: string) => sql(env, `select (select string_agg(content || ':' || read, ',' order by created_at)
  from public.chat_messages where sender_id = :'a' and recipient_id = :'b') || ' ' || (select string_agg(read::text, ',')
  from public.notifications where user_id = :'b' and type = 'chat_message' and data ->> 'user_id' = :'a')`, { a, b })
const UNREAD = 'm1:false,m2:false false'

export const restSpecs: RouteSpec[] = [
  spec('POST', 'rpc/sync_profile_packs', 'R§3.1', [
    {
      name: '{ user_id: moi } → 200 [ligne] ; { user_id: autre } → 403 42501 ; anon → 401',
      run: async (env) => {
        const [me, other] = players(env)
        const rows = z.array(Synced).length(1).parse(await status(await rest(env, 'rpc/sync_profile_packs', { method: 'POST', uid: me, body: { user_id: me } }), 200))
        assert.equal(rows[0].username, sql(env, `select username from public.profiles where id = :'me'`, { me }))
        await pgError(await rest(env, 'rpc/sync_profile_packs', { method: 'POST', uid: me, body: { user_id: other } }), 403, '42501')
        await status(await rest(env, 'rpc/sync_profile_packs', { method: 'POST', body: { user_id: me } }), 401)
      },
    },
  ]),
  spec('POST', 'rpc/get_my_profile', 'R§3.1', [
    {
      name: '→ 200 [{ id: moi, … }]',
      run: async (env) => {
        const [me] = players(env)
        const rows = z.array(Profile).length(1).parse(await status(await rest(env, 'rpc/get_my_profile', { method: 'POST', uid: me, body: {} }), 200))
        assert.equal(rows[0].id, me)
      },
    },
  ]),
  spec('GET', 'cards', 'R§3.4', [
    {
      name: 'anon, select du R§3.4 et id=in.(…) → 200 Card[] ; select=summary&id=eq. (modale)',
      run: async (env) => {
        const ids = anyCards(env, 3)
        const rows = z.array(Card).length(3).parse(await status(await rest(env, `cards?select=${CARD_COLUMNS}&id=in.(${ids})`), 200))
        assert.deepEqual(rows.map((c) => c.id).sort(), ids.toSorted())
        const [one] = (await status(await rest(env, `cards?select=summary&id=eq.${ids[0]}`), 200)) as Array<Record<string, unknown>>
        assert.deepEqual(Object.keys(one), ['summary'])
      },
    },
  ]),
  spec('GET', 'user_cards', 'R§3.3', [
    {
      name: 'select du R§3.3 & user_id=eq.<moi> → mes lignes seulement, liaisons et carte embarquées ; user_id d\'un autre → []',
      run: async (env) => {
        const [me, other] = players(env)
        const mine = giveCards(env.backend.databaseUrl, me, 'C', 2)
        giveCards(env.backend.databaseUrl, other, 'C')
        const t = tag(env, me, 'a')
        sql(env, `insert into public.user_card_tags (user_card_id, tag_id) values (:'c', :'t')`, { c: mine[0], t })
        const select = 'id,card_id,count,starred,is_shiny,obtained_at,snapshot_title,snapshot_rarity,snapshot_category,user_card_tags(tag_id),card:cards(id,wikipedia_title,rarity)'
        const rows = (await status(await rest(env, `user_cards?select=${select}&user_id=eq.${me}&order=obtained_at.desc`, { uid: me, headers: { range: '0-999' } }), 200)) as Array<{ id: string; card_id: string; user_card_tags: unknown[]; card: { id: string } }>
        assert.deepEqual(rows.map((r) => r.id).sort(), mine.toSorted())
        assert.ok(rows.every((r) => r.card.id === r.card_id))
        assert.deepEqual(rows.find((r) => r.id === mine[0])?.user_card_tags, [{ tag_id: t }])
        assert.deepEqual(await status(await rest(env, `user_cards?select=id&user_id=eq.${other}`, { uid: me }), 200), [])
        assert.equal(((await status(await rest(env, 'user_cards?select=id', { uid: me }), 200)) as unknown[]).length, 2)
      },
    },
  ]),
  spec('PATCH', 'user_cards', 'R§3.3', [
    {
      name: 'id=in.(la mienne, celle d\'un autre) { starred: true } → 204, seule la mienne change ; { count: 9 } → 403 42501',
      run: async (env) => {
        const [me, other] = players(env)
        const [mine] = giveCards(env.backend.databaseUrl, me, 'C')
        const [theirs] = giveCards(env.backend.databaseUrl, other, 'C')
        await status(await rest(env, `user_cards?id=in.(${mine},${theirs})`, { method: 'PATCH', uid: me, body: { starred: true }, headers: MINIMAL }), 204)
        assert.equal(sql(env, `select string_agg(starred::text, ',' order by user_id = :'me' desc) from public.user_cards where id in (:'a', :'b')`,
          { me, a: mine, b: theirs }), 'true,false')
        await pgError(await rest(env, `user_cards?id=eq.${mine}`, { method: 'PATCH', uid: me, body: { count: 9 }, headers: MINIMAL }), 403, '42501')
        assert.equal(sql(env, `select count from public.user_cards where id = :'a'`, { a: mine }), '1')
      },
    },
  ]),
  spec('GET', 'tags', 'R§3.3', [
    {
      name: 'select=id,name,color&user_id=eq.<moi>&order=name.asc → mes étiquettes triées ; recherche par nom ; celles d\'un autre → []',
      run: async (env) => {
        const [me, other] = players(env)
        const b = tag(env, me, 'b')
        const a = tag(env, me, 'a')
        tag(env, other, 'c')
        assert.deepEqual(await status(await rest(env, `tags?select=id,name,color&user_id=eq.${me}&order=name.asc`, { uid: me }), 200),
          [{ id: a, name: 'a', color: null }, { id: b, name: 'b', color: null }])
        assert.deepEqual(await status(await rest(env, `tags?user_id=eq.${me}&name=eq.b&select=id&limit=1`, { uid: me }), 200), [{ id: b }])
        assert.deepEqual(await status(await rest(env, `tags?select=id&user_id=eq.${other}`, { uid: me }), 200), [])
      },
    },
  ]),
  spec('POST', 'tags', 'R§3.3', [
    {
      name: '{ user_id, name, color: "#fb7185" } → 201 [ligne] ; même nom → 409 23505 ; « [LOCKED] » gardé tel quel ; user_id d\'un autre → 403',
      run: async (env) => {
        const [me, other] = players(env)
        const post = (body: unknown) => rest(env, 'tags', { method: 'POST', uid: me, body, headers: REPRESENTATION })
        const [{ id, created_at, ...row }] = (await status(await post({ user_id: me, name: 'Favoris', color: '#fb7185' }), 201)) as Array<Record<string, unknown>>
        assert.deepEqual([z.uuid().parse(id), typeof created_at, row], [id, 'string', { user_id: me, name: 'Favoris', color: '#fb7185' }])
        await pgError(await post({ user_id: me, name: 'Favoris', color: null }), 409, '23505')
        const [locked] = (await status(await post({ user_id: me, name: '[LOCKED] Deck', color: null }), 201)) as Array<{ name: string }>
        assert.equal(locked.name, '[LOCKED] Deck')
        await pgError(await post({ user_id: other, name: 'Intrus', color: null }), 403, '42501')
      },
    },
  ]),
  spec('PATCH', 'tags', 'R§3.3', [
    {
      name: 'id=eq.<la mienne> { name, color } → renommée et recolorée ; celle d\'un autre inchangée',
      run: async (env) => {
        const [me, other] = players(env)
        const mine = tag(env, me, 'avant')
        const theirs = tag(env, other, 'avant')
        for (const id of [mine, theirs]) {
          await status(await rest(env, `tags?id=eq.${id}`, { method: 'PATCH', uid: me, body: { name: 'après', color: '#22c55e' }, headers: MINIMAL }), 204)
        }
        assert.equal(sql(env, `select string_agg(name || coalesce(color, ''), ',' order by user_id = :'me' desc) from public.tags where id in (:'a', :'b')`,
          { me, a: mine, b: theirs }), 'après#22c55e,avant')
      },
    },
  ]),
  spec('DELETE', 'tags', 'R§3.3', [
    {
      name: 'id=eq.<tagId> → 200 [ligne supprimée], ses liaisons disparaissent en cascade',
      run: async (env) => {
        const [me] = players(env)
        const copies = giveCards(env.backend.databaseUrl, me, 'C', 3)
        const t = tag(env, me, 'à jeter')
        sql(env, `insert into public.user_card_tags (user_card_id, tag_id) select unnest(string_to_array(:'c', ',')::uuid[]), :'t'`, { c: copies.join(','), t })
        const rows = (await status(await rest(env, `tags?id=eq.${t}`, { method: 'DELETE', uid: me, headers: { prefer: 'return=representation' } }), 200)) as Array<{ id: string }>
        assert.deepEqual(rows.map((r) => r.id), [t])
        assert.equal(sql(env, `select count(*) from public.user_card_tags where tag_id = :'t'`, { t }), '0')
      },
    },
  ]),
  spec('POST', 'user_card_tags', 'R§3.3', [
    {
      name: 'tableau de 100 avec ignore-duplicates → 201 ×2, 100 liaisons ; doublon sans ignore-duplicates → 409 23505 ; étiquette d\'un autre → 403',
      run: async (env) => {
        const [me, other] = players(env)
        const copies = giveCards(env.backend.databaseUrl, me, 'C', 100)
        const t = tag(env, me, 'lot')
        const links = copies.map((user_card_id) => ({ user_card_id, tag_id: t }))
        const ignore = { prefer: 'resolution=ignore-duplicates,count=exact,return=minimal' }
        for (let i = 0; i < 2; i++) {
          await status(await rest(env, 'user_card_tags?on_conflict=user_card_id,tag_id', { method: 'POST', uid: me, body: links, headers: ignore }), 201)
        }
        assert.equal(sql(env, `select count(*) from public.user_card_tags where tag_id = :'t'`, { t }), '100')
        await pgError(await rest(env, 'user_card_tags', { method: 'POST', uid: me, body: links[0], headers: MINIMAL }), 409, '23505')
        const foreign = { user_card_id: copies[0], tag_id: tag(env, other, 'autre') }
        await pgError(await rest(env, 'user_card_tags', { method: 'POST', uid: me, body: foreign, headers: MINIMAL }), 403, '42501')
      },
    },
  ]),
  spec('DELETE', 'user_card_tags', 'R§3.3', [
    {
      name: 'tag_id=eq.&user_card_id=in.(…) → 204, seules ces liaisons partent',
      run: async (env) => {
        const [me] = players(env)
        const copies = giveCards(env.backend.databaseUrl, me, 'C', 3)
        const t = tag(env, me, 'x')
        sql(env, `insert into public.user_card_tags (user_card_id, tag_id) select unnest(string_to_array(:'c', ',')::uuid[]), :'t'`, { c: copies.join(','), t })
        await status(await rest(env, `user_card_tags?tag_id=eq.${t}&user_card_id=in.(${copies.slice(0, 2)})`, { method: 'DELETE', uid: me }), 204)
        assert.equal(sql(env, `select string_agg(user_card_id::text, ',') from public.user_card_tags where tag_id = :'t'`, { t }), copies[2])
      },
    },
  ]),
  spec('POST', 'wishlist_items', 'R§3.3', [
    {
      name: '{ user_id, card_id } → 201 ; tableau avec un doublon et ignore-duplicates → 201 ; user_id d\'un autre → 403 42501',
      run: async (env) => {
        const [me, other] = players(env)
        const [first, second] = anyCards(env, 2)
        const post = (body: unknown, prefer = 'resolution=ignore-duplicates') => rest(env, 'wishlist_items', { method: 'POST', uid: me, body, headers: { prefer } })
        await status(await post({ user_id: me, card_id: first }), 201)
        await status(await post([{ user_id: me, card_id: first }, { user_id: me, card_id: second }]), 201)
        assert.equal(sql(env, `select count(*) from public.wishlist_items where user_id = :'me'`, { me }), '2')
        await pgError(await post({ user_id: other, card_id: first }), 403, '42501')
      },
    },
  ]),
  spec('GET', 'wishlist_items', 'R§3.3', [
    {
      name: 'select=card_id&user_id=eq.<moi>&order=created_at.desc → le plus récent d\'abord ; ceux d\'un autre → []',
      run: async (env) => {
        const [me, other] = players(env)
        const [old, recent] = anyCards(env, 2)
        sql(env, `insert into public.wishlist_items (user_id, card_id, created_at) values (:'me', :'old', now() - interval '1 minute'),
  (:'me', :'recent', now()), (:'other', :'old', now())`, { me, other, old, recent })
        assert.deepEqual(await status(await rest(env, `wishlist_items?select=card_id&user_id=eq.${me}&order=created_at.desc`, { uid: me }), 200),
          [{ card_id: recent }, { card_id: old }])
        assert.deepEqual(await status(await rest(env, `wishlist_items?select=card_id&user_id=eq.${other}`, { uid: me }), 200), [])
      },
    },
  ]),
  spec('DELETE', 'wishlist_items', 'R§3.3', [
    {
      name: 'user_id=eq.&card_id=eq. → 204, seul ce souhait part',
      run: async (env) => {
        const [me] = players(env)
        const [kept, gone] = anyCards(env, 2)
        sql(env, `insert into public.wishlist_items (user_id, card_id) values (:'me', :'kept'), (:'me', :'gone')`, { me, kept, gone })
        await status(await rest(env, `wishlist_items?user_id=eq.${me}&card_id=eq.${gone}`, { method: 'DELETE', uid: me }), 204)
        assert.equal(sql(env, `select string_agg(card_id::text, ',') from public.wishlist_items where user_id = :'me'`, { me }), kept)
      },
    },
  ]),
  spec('GET', 'auctions', 'R§3.5', [
    {
      name: 'sélection du R§3.5, seller_id=eq.&status=eq.active&order=end_at.asc → l\'enchère active d\'un autre, card embarquée ; POST → 403 42501 ; anon → 401',
      run: async (env) => {
        const [me] = players(env)
        const s = seller(env, { cards: 2 })
        const [kept, gone] = s.copies.map((copy) => listed(env, s.uid, copy))
        sql(env, `select wm.cancel_auction(:'uid', :'id')`, { uid: s.uid, id: gone })
        const query = `auctions?select=${AUCTION_COLUMNS},card:cards(wikipedia_title,rarity,image_url)&seller_id=eq.${s.uid}&status=eq.active&order=end_at.asc`
        const rows = (await status(await rest(env, query, { uid: me }), 200)) as Array<{ id: string; card: Record<string, unknown> }>
        // L'objet embarqué sort de jsonb, qui trie ses clés : comparées triées.
        assert.deepEqual(rows.map((r) => [r.id, Object.keys(r), Object.keys(r.card).sort()]),
          [[kept, [...AUCTION_COLUMNS.split(','), 'card'], ['image_url', 'rarity', 'wikipedia_title']]])
        assert.equal(rows[0].card.wikipedia_title, sql(env, `select c.wikipedia_title from public.cards c join public.auctions a on a.card_id = c.id
where a.id = :'id'`, { id: kept }))
        await pgError(await rest(env, 'auctions', { method: 'POST', uid: me, body: { seller_id: me }, headers: MINIMAL }), 403, '42501')
        await status(await rest(env, 'auctions?select=id'), 401)
      },
    },
  ]),
  spec('GET', 'auction_bids', 'R§3.5', [
    {
      name: 'select=auction_id,amount,placed_at&bidder_id=eq.<moi>&order=placed_at.desc → mes mises, la plus récente d\'abord ; PATCH → 403 42501',
      run: async (env) => {
        const s = seller(env, { cards: 2 })
        const [a, b] = s.copies.map((copy) => listed(env, s.uid, copy))
        const [me, other] = [0, 1].map(() => makeUser(env.backend.databaseUrl, { balance: 1000, humanVerified: true }).uid)
        const place = (uid: string, id: string, amount: number) =>
          sql(env, `select wm.place_bid(:'uid', :'id', :'amount'::int)`, { uid, id, amount: String(amount) })
        place(me, a, 100)
        place(other, b, 100)
        place(me, b, 110)
        const rows = (await status(await rest(env, `auction_bids?select=auction_id,amount,placed_at&bidder_id=eq.${me}&order=placed_at.desc`,
          { uid: me }), 200)) as Array<Record<string, unknown>>
        assert.deepEqual(rows.map((r) => [r.auction_id, r.amount]), [[b, 110], [a, 100]])
        assert.deepEqual(Object.keys(rows[0]), ['auction_id', 'amount', 'placed_at'])
        await pgError(await rest(env, `auction_bids?bidder_id=eq.${me}`, { method: 'PATCH', uid: me, body: { amount: 1 }, headers: MINIMAL }), 403, '42501')
      },
    },
  ]),
  spec('POST', 'trades', 'R§3.6', [
    {
      name: 'en participant → 403 42501 ; anon → 401 ; aucune ligne créée ; authenticated sans insert, update ni delete',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b)
        const row = { initiator_id: a.uid, recipient_id: b.uid, expires_at: new Date(Date.now() + 3_600_000).toISOString() }
        await pgError(await rest(env, 'trades', { method: 'POST', uid: a.uid, body: row, headers: MINIMAL }), 403, '42501')
        await status(await rest(env, 'trades', { method: 'POST', body: row, headers: MINIMAL }), 401)
        onlyPending(env, a.uid, id)
        // Aucun droit d'écriture (0005) : le 42501 seul ne le distingue pas d'un droit accordé que la RLS refuserait aussi.
        assert.equal(sql(env, `select not has_table_privilege('authenticated', 'public.trades', 'INSERT')
  and not has_table_privilege('authenticated', 'public.trades', 'UPDATE') and not has_table_privilege('authenticated', 'public.trades', 'DELETE')`), 't')
      },
    },
  ], 'inc.'),
  spec('PATCH', 'trades', 'R§3.6', [
    {
      name: 'id=eq.<id> { status: accepted } en participant, puis en non-participant → 403 42501 ; anon → 401 ; l\'échange reste pending',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b)
        const patch = (uid?: string) => rest(env, `trades?id=eq.${id}`, { method: 'PATCH', uid, body: { status: 'accepted' }, headers: MINIMAL })
        for (const uid of [b.uid, makeUser(env.backend.databaseUrl).uid]) await pgError(await patch(uid), 403, '42501')
        await status(await patch(), 401)
        onlyPending(env, a.uid, id)
      },
    },
  ], 'inc.'),
  spec('DELETE', 'trades', 'R§3.6', [
    {
      name: 'id=eq.<id> en participant → 403 42501 ; anon → 401 ; l\'échange reste pending',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b)
        await pgError(await rest(env, `trades?id=eq.${id}`, { method: 'DELETE', uid: a.uid }), 403, '42501')
        await status(await rest(env, `trades?id=eq.${id}`, { method: 'DELETE' }), 401)
        onlyPending(env, a.uid, id)
      },
    },
  ], 'inc.'),
  spec('PATCH', 'chat_messages', 'R§3.7', [
    {
      name: 'sender_id=eq.A&recipient_id=eq.B&read=eq.false {read: true} : par A, par Carol → 204 sans effet ; {content} par B → 403 42501 ; anon → 401 42501 ; par B → 204, lus avec la chat_message (trigger), relus par A, invisibles à Carol',
      run: async (env) => {
        const [a, b] = chatted(env)
        const carol = makeUser(env.backend.databaseUrl).uid
        const mark = (uid?: string, body: unknown = { read: true }) =>
          rest(env, `chat_messages?sender_id=eq.${a}&recipient_id=eq.${b}&read=eq.false`, { method: 'PATCH', uid, body, headers: MINIMAL })
        for (const uid of [a, carol]) {
          await status(await mark(uid), 204)
          assert.equal(chatState(env, a, b), UNREAD, uid)
        }
        await pgError(await mark(b, { content: 'x' }), 403, '42501')
        // Un with check de la RLS rendrait aussi 42501 : c'est bien le droit de colonne qui manque (DG:453).
        assert.equal(sql(env, `select has_column_privilege('authenticated', 'public.chat_messages', 'content', 'update')`), 'f')
        await pgError(await mark(), 401, '42501')
        assert.equal(chatState(env, a, b), UNREAD)
        await status(await mark(b), 204)
        assert.equal(chatState(env, a, b), 'm1:true,m2:true true')
        assert.deepEqual(await status(await rest(env, `chat_messages?select=content,read&sender_id=eq.${a}&order=created_at`, { uid: a }), 200),
          [{ content: 'm1', read: true }, { content: 'm2', read: true }])
        assert.deepEqual(await status(await rest(env, `chat_messages?select=id&sender_id=eq.${a}`, { uid: carol }), 200), [])
      },
    },
  ], 'prob.'),
  spec('POST', 'chat_messages', 'R§3.7', [
    {
      name: 'un message de A à B, posté par A → 403 42501, aucune ligne de plus',
      run: async (env) => {
        const [a, b] = chatted(env)
        await pgError(await rest(env, 'chat_messages', { method: 'POST', uid: a, body: { sender_id: a, recipient_id: b, content: 'direct' }, headers: MINIMAL }),
          403, '42501')
        assert.equal(chatState(env, a, b), UNREAD)
      },
    },
  ], 'inc.'),
  spec('DELETE', 'chat_messages', 'R§3.7', [
    {
      name: 'sender_id=eq.A par A, puis par B → 403 42501, les lignes restent',
      run: async (env) => {
        const [a, b] = chatted(env)
        for (const uid of [a, b]) await pgError(await rest(env, `chat_messages?sender_id=eq.${a}`, { method: 'DELETE', uid }), 403, '42501')
        assert.equal(chatState(env, a, b), UNREAD)
      },
    },
  ], 'inc.'),
]
