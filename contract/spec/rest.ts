// Surface PostgREST directe de l'original sous RLS (R§3.1, R§3.3, R§3.4) : passerelle, clé publiable, JWT du joueur en Bearer.
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { accessToken, giveCards, makeUser, psql } from '../users.ts'
import { Card, CARD_COLUMNS } from './catalog.ts'

const KEY = 'sb_publishable_test'

function rest(env: ContractEnv, path: string, init: { method?: string; uid?: string; body?: unknown; headers?: Record<string, string> } = {}) {
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

const Profile = z.object({ id: z.uuid(), username: z.string() }).loose()
const Synced = z.strictObject({
  username: z.string(), avatar_url: z.string().nullable(), is_pro: z.boolean(), is_vip: z.boolean(), pack_cap: z.int(), packs_remaining: z.int(),
  packs_last_regen_at: z.string().nullable(), wikibidous_balance: z.int(), next_regen_at: z.string().nullable(),
})

const spec = (method: RouteSpec['method'], path: string, source: string, cases: RouteSpec['cases']): RouteSpec =>
  ({ method, path: `rest/v1/${path}`, source, confidence: 'conf.', cases })

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
]
