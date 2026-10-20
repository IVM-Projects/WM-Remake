import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, failed, giveCards, Iso, makeUser, noSession, ok, psql, Rarity } from '../users.ts'

// Item du R§3.3, clés sûres de l'union (tags en {id, name, color}).
const Item = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  card_id: z.uuid(),
  card: z.object({
    id: z.uuid(), wikipedia_title: z.string(), rarity: Rarity, category: z.string().nullable(), atk: z.int(), def: z.int(),
    image_url: z.string().nullable(), hide_image: z.boolean(), wikipedia_url: z.string(), description: z.string().nullable(),
  }),
  snapshot_rarity: Rarity,
  is_shiny: z.boolean(),
  starred: z.boolean(),
  count: z.int().min(1),
  tags: z.array(z.object({ id: z.uuid(), name: z.string(), color: z.string().nullable() })),
  obtained_at: Iso,
})
const Collection = z.object({ collection: z.array(Item), total: z.int(), pendingTradeCardIds: z.array(z.uuid()) })
const Stats = z.object({ total: z.int(), rarities: z.array(z.object({ rarity: Rarity, count: z.int() }).loose()).length(6) })
const ProfileCollection = z.object({
  collection: z.array(z.object({ id: z.uuid(), card: z.object({ id: z.uuid(), rarity: Rarity }).loose(), count: z.int(), is_shiny: z.boolean() })),
  total: z.int(),
  rarityCounts: z.record(Rarity, z.int()).optional(),
})
const Failed = z.object({ discarded_count: z.int(), failed: z.array(z.object({ id: z.uuid(), reason: z.string() })) })

const sql = (env: ContractEnv, query: string, vars: Record<string, string>) => psql(env.backend.databaseUrl, query, vars)
const post = (env: ContractEnv, path: string, uid?: string, body?: unknown, headers?: Record<string, string>) =>
  api(env, path, { method: 'POST', uid, body, headers })
// 2 L, 3 UR et 5 C : assez pour le filtre et les stats par rareté.
function mixedUser(env: ContractEnv): string {
  const { uid } = makeUser(env.backend.databaseUrl)
  for (const [rarity, n] of [['L', 2], ['UR', 3], ['C', 5]] as const) giveCards(env.backend.databaseUrl, uid, rarity, n)
  return uid
}

export const myCollection: RouteSpec = {
  method: 'GET',
  path: '/api/my-collection',
  source: 'R§3.3',
  confidence: 'conf.',
  cases: [
    noSession('GET', '/api/my-collection'),
    {
      name: '60 copies → { collection, total: 60, pendingTradeCardIds: [] } ; pages de 50 en base 0 ; limit=500 → 50',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        giveCards(env.backend.databaseUrl, uid, 'C', 60)
        const first = await ok(await api(env, '/api/my-collection', { uid }), Collection)
        assert.deepEqual([first.collection.length, first.total, first.pendingTradeCardIds], [50, 60, []])
        const second = await ok(await api(env, '/api/my-collection?page=1', { uid }), Collection)
        assert.equal(second.collection.length, 10)
        assert.equal(new Set([...first.collection, ...second.collection].map((i) => i.id)).size, 60)
        assert.ok(first.collection.every((i) => i.user_id === uid && i.card.id === i.card_id))
        assert.equal((await ok(await api(env, '/api/my-collection?limit=500', { uid }), Collection)).collection.length, 50)
      },
    },
    {
      name: 'rarity=L&rarity=UR → les 5 copies L et UR seulement ; rarity=L seul → 2',
      run: async (env) => {
        const uid = mixedUser(env)
        const both = await ok(await api(env, '/api/my-collection?rarity=L&rarity=UR', { uid }), Collection)
        assert.equal(both.total, 5)
        assert.deepEqual(both.collection.map((i) => i.snapshot_rarity), ['L', 'L', 'UR', 'UR', 'UR'])
        assert.equal((await ok(await api(env, '/api/my-collection?rarity=L', { uid }), Collection)).total, 2)
      },
    },
    {
      name: 'les 7 tris acceptés ; name → titres croissants, atk → atk décroissante (ordre de PG) ; sort=xyz → 400 ; rarity=X → 400',
      run: async (env) => {
        const uid = mixedUser(env)
        for (const sort of ['rarity', 'obtained_at', 'added', 'name', 'atk', 'def', 'starred']) {
          assert.equal((await ok(await api(env, `/api/my-collection?sort=${sort}`, { uid }), Collection)).total, 10, sort)
        }
        // Valeurs comparées, pas les ids : l'ordre des ex aequo ne compte pas ici.
        const byName = await ok(await api(env, '/api/my-collection?sort=name', { uid }), Collection)
        assert.equal(byName.collection.map((i) => i.card.wikipedia_title).join('|'),
          sql(env, `select string_agg(snapshot_title, '|' order by snapshot_title) from public.user_cards where user_id = :'uid'`, { uid }))
        const byAtk = await ok(await api(env, '/api/my-collection?sort=atk', { uid }), Collection)
        assert.equal(byAtk.collection.map((i) => i.card.atk).join(','),
          sql(env, `select string_agg(snapshot_atk::text, ',' order by snapshot_atk desc) from public.user_cards where user_id = :'uid'`, { uid }))
        await failed(await api(env, '/api/my-collection?sort=xyz', { uid }), 400, 'invalid_request')
        await failed(await api(env, '/api/my-collection?rarity=X', { uid }), 400, 'invalid_request')
      },
    },
    {
      name: 'q ou search filtrent le titre ; pending=1 et stats=1 acceptés sans effet',
      run: async (env) => {
        const uid = mixedUser(env)
        const title = sql(env, `select snapshot_title from public.user_cards where user_id = :'uid' and snapshot_rarity = 'C' limit 1`, { uid })
        const q = encodeURIComponent(title.slice(-4)) // numéro à 4 chiffres, unique dans le seed
        for (const path of [`?q=${q}`, `?search=${q}&pending=1&stats=1`]) {
          const { collection, total } = await ok(await api(env, `/api/my-collection${path}`, { uid }), Collection)
          assert.deepEqual([total, collection.map((i) => i.card.wikipedia_title)], [1, [title]], path)
        }
        assert.equal((await ok(await api(env, '/api/my-collection?pending=1&stats=0', { uid }), Collection)).total, 10)
      },
    },
  ],
}

export const myCollectionStats: RouteSpec = {
  method: 'GET',
  path: '/api/my-collection/stats',
  source: 'R§3.3',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/my-collection/stats'),
    {
      name: '→ { total, rarities } (6 raretés, comptes exacts) ; rarity=L → total 2',
      run: async (env) => {
        const uid = mixedUser(env)
        const { total, rarities } = await ok(await api(env, '/api/my-collection/stats', { uid }), Stats)
        assert.equal(total, 10)
        assert.deepEqual(Object.fromEntries(rarities.map((r) => [r.rarity, r.count])), { L: 2, UR: 3, SR: 0, R: 0, PC: 0, C: 5 })
        assert.equal((await ok(await api(env, '/api/my-collection/stats?rarity=L&sort=name', { uid }), Stats)).total, 2)
      },
    },
  ],
}

export const profileCollection: RouteSpec = {
  method: 'GET',
  path: '/api/profile/{username}/collection',
  source: 'R§3.3',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/profile/inconnu/collection'),
    {
      name: 'pseudo inconnu → 404 « Joueur introuvable »',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const body = await failed(await api(env, `/api/profile/x_${randomUUID().slice(-12)}/collection`, { uid }), 404)
        assert.equal(body.error, 'Joueur introuvable')
      },
    },
    {
      name: 'profil privé d\'un autre → 403 FORBIDDEN',
      run: async (env) => {
        const owner = makeUser(env.backend.databaseUrl)
        const { uid } = makeUser(env.backend.databaseUrl)
        sql(env, `update public.profiles set is_public = false where id = :'uid'`, { uid: owner.uid })
        await failed(await api(env, `/api/profile/${owner.username}/collection`, { uid }), 403, 'FORBIDDEN')
      },
    },
    {
      name: 'profil public → { collection, total } sans rarityCounts ; stats=1 → rarityCounts en cartes uniques, C à L',
      run: async (env) => {
        const owner = makeUser(env.backend.databaseUrl)
        giveCards(env.backend.databaseUrl, owner.uid, 'L', 2)
        giveCards(env.backend.databaseUrl, owner.uid, 'C', 3)
        const { uid } = makeUser(env.backend.databaseUrl)
        const plain = await ok(await api(env, `/api/profile/${owner.username}/collection`, { uid }), ProfileCollection)
        assert.deepEqual([plain.collection.length, plain.total, plain.rarityCounts], [5, 5, undefined])
        const stats = await ok(await api(env, `/api/profile/${owner.username.toUpperCase()}/collection?stats=1&page=0`, { uid }), ProfileCollection)
        assert.deepEqual(stats.rarityCounts, { C: 3, PC: 0, R: 0, SR: 0, UR: 0, L: 2 })
      },
    },
  ],
}

export const discard: RouteSpec = {
  method: 'POST',
  path: '/api/user-cards/{userCardId}/discard',
  source: 'R§3.3',
  confidence: 'conf.',
  cases: [
    noSession('POST', `/api/user-cards/${randomUUID()}/discard`),
    {
      name: 'sa copie → 200 { balance } +1, copie retirée ; même Idempotency-Key → même corps, une seule défausse',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { balance: 10 })
        const [copy] = giveCards(env.backend.databaseUrl, uid, 'C')
        const key = { 'Idempotency-Key': randomUUID() }
        const path = `/api/user-cards/${copy}/discard`
        assert.deepEqual(await ok(await post(env, path, uid, undefined, key), z.unknown()), { balance: 11 })
        assert.deepEqual(await ok(await post(env, path, uid, undefined, key), z.unknown()), { balance: 11 })
        assert.equal(sql(env, `select wikibidous_balance || '/' || (select count(*) from public.user_cards where user_id = :'uid')
          from public.profiles where id = :'uid'`, { uid }), '11/0')
      },
    },
    {
      name: 'copie d\'un autre joueur → 403 code 42501 « Vous ne possédez pas cette carte », copie intacte',
      run: async (env) => {
        const other = makeUser(env.backend.databaseUrl)
        const [copy] = giveCards(env.backend.databaseUrl, other.uid, 'C')
        const { uid } = makeUser(env.backend.databaseUrl)
        const body = await failed(await post(env, `/api/user-cards/${copy}/discard`, uid), 403, '42501')
        assert.equal(body.error, 'Vous ne possédez pas cette carte')
        assert.equal(sql(env, `select count(*) from public.user_cards where id = :'id'`, { id: copy }), '1')
      },
    },
    {
      name: 'userCardId=abc → 400 invalid_request (jamais 500)',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        await failed(await post(env, '/api/user-cards/abc/discard', uid), 400, 'invalid_request')
      },
    },
  ],
}

export const bulkDiscard: RouteSpec = {
  method: 'POST',
  path: '/api/user-cards/bulk-discard',
  source: 'R§3.3',
  confidence: 'conf.',
  cases: [
    noSession('POST', '/api/user-cards/bulk-discard'),
    {
      name: '51 ids, 0 id ou un id non uuid → 400 invalid_request ; [id, id] → 400 « Cartes en double dans la défausse »',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        for (const card_ids of [Array.from({ length: 51 }, () => randomUUID()), [], ['abc']]) {
          await failed(await post(env, '/api/user-cards/bulk-discard', uid, { card_ids }), 400, 'invalid_request')
        }
        const [copy] = giveCards(env.backend.databaseUrl, uid, 'C')
        const twice = await failed(await post(env, '/api/user-cards/bulk-discard', uid, { card_ids: [copy, copy] }), 400, 'invalid_request')
        assert.equal(twice.error, 'Cartes en double dans la défausse')
        assert.equal(sql(env, `select count(*) from public.user_cards where id = :'id'`, { id: copy }), '1')
      },
    },
    {
      name: '2 copies à soi + 1 d\'un autre + 1 inconnue → discarded_count 2, failed = les 2 autres dans l\'ordre, solde +2',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { balance: 5 })
        const mine = giveCards(env.backend.databaseUrl, uid, 'C', 2)
        const [theirs] = giveCards(env.backend.databaseUrl, makeUser(env.backend.databaseUrl).uid, 'C')
        const unknown = randomUUID()
        const res = await post(env, '/api/user-cards/bulk-discard', uid, { card_ids: [mine[0], theirs, mine[1], unknown] })
        const { discarded_count, failed: rest } = await ok(res, Failed)
        assert.equal(discarded_count, 2)
        assert.deepEqual(rest.map((f) => f.id), [theirs, unknown])
        assert.equal(sql(env, `select wikibidous_balance from public.profiles where id = :'uid'`, { uid }), '7')
      },
    },
  ],
}

export const collection: RouteSpec[] = [myCollection, myCollectionStats, profileCollection, discard, bulkDiscard]
