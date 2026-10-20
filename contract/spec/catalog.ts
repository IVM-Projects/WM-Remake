import assert from 'node:assert/strict'
import { z } from 'zod'
import type { RouteSpec } from '../../lib/contract.ts'
import { api, failed, giveCards, Iso, makeUser, noSession, ok, psql, Rarity } from '../users.ts'

// Colonnes de `rest/v1/cards` lues par les clients (R§3.4) : aussi les clés de chaque carte de /api/cards.
export const CARD_COLUMNS = 'id,atk,def,lang,rarity,q_score,category,image_url,pageviews,hide_image,nsfw_image,wikipedia_url,wikipedia_title,summary,pageviews_refreshed_at,qscore_refreshed_at'

export const Card = z.strictObject({
  id: z.uuid(), atk: z.int(), def: z.int(), lang: z.string(), rarity: Rarity, q_score: z.number().nullable(), category: z.string().nullable(),
  image_url: z.string().nullable(), pageviews: z.int(), hide_image: z.boolean(), nsfw_image: z.boolean(), wikipedia_url: z.string(),
  wikipedia_title: z.string(), summary: z.string().nullable(), pageviews_refreshed_at: Iso.nullable(), qscore_refreshed_at: Iso.nullable(),
})
const Overlay = { cards: z.array(Card).max(50), ownedCardIds: z.array(z.uuid()), wishlistCardIds: z.array(z.uuid()), friendOwners: z.record(z.string(), z.unknown()) }
const Page = z.strictObject({ ...Overlay, total: z.int(), rarityCounts: z.record(Rarity, z.int()) })
const Search = z.strictObject({ ...Overlay, total: z.null(), searchHasMore: z.boolean() })
const Filtered = z.strictObject({ ...Overlay, total: z.int() })

export const cards: RouteSpec = {
  method: 'GET',
  path: '/api/cards',
  source: 'R§3.4',
  confidence: 'conf.',
  cases: [
    noSession('GET', '/api/cards'),
    {
      name: 'page 0 → clés du R§3.4, 50 cartes L d\'abord, total et rarityCounts du pool ; sort=rarity accepté, sort=xyz → 400',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const page = await ok(await api(env, '/api/cards?sort=rarity', { uid }), Page)
        assert.equal(page.cards.length, 50)
        assert.equal(page.cards[0].rarity, 'L')
        assert.deepEqual(Object.keys(page.cards[0]).sort(), CARD_COLUMNS.split(',').sort())
        const pool = JSON.parse(psql(env.backend.databaseUrl, 'select json_object_agg(rarity, n) from wm.catalog_stats')) as Record<string, number>
        assert.deepEqual(page.rarityCounts, pool)
        assert.equal(page.total, Object.values(pool).reduce((a, b) => a + b))
        assert.deepEqual([page.ownedCardIds, page.wishlistCardIds, page.friendOwners], [[], [], {}])
        const next = await ok(await api(env, '/api/cards?page=1', { uid }), Page)
        assert.ok(!next.cards.some((c) => page.cards.some((p) => p.id === c.id)))
        await failed(await api(env, '/api/cards?sort=xyz', { uid }), 400, 'invalid_request')
      },
    },
    {
      name: 'q=a → 400 « La recherche demande au moins 2 caractères »',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const body = await failed(await api(env, '/api/cards?q=a', { uid }), 400, 'invalid_request')
        assert.equal(body.error, 'La recherche demande au moins 2 caractères')
      },
    },
    {
      name: 'recherche → total: null, searchHasMore, sans rarityCounts ; rarity répétée filtre la recherche',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const broad = await ok(await api(env, '/api/cards?q=essai', { uid }), Search)
        assert.deepEqual([broad.cards.length, broad.searchHasMore], [50, true])
        const narrow = await ok(await api(env, '/api/cards?q=essai&rarity=L&rarity=UR', { uid }), Search)
        assert.ok(narrow.cards.every((c) => c.rarity === 'L' || c.rarity === 'UR'))
        assert.equal(narrow.searchHasMore, false)
      },
    },
    {
      name: 'ownedCardIds et wishlistCardIds reflètent une copie et un souhait ; wishlist=1 ne rend que le souhait',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const [copy] = giveCards(env.backend.databaseUrl, uid, 'L')
        const owned = psql(env.backend.databaseUrl, `select card_id from public.user_cards where id = :'id'`, { id: copy })
        const wished = psql(env.backend.databaseUrl, `insert into public.wishlist_items (user_id, card_id)
select :'uid', id from public.cards where rarity = 'L' and id <> :'owned' limit 1 returning card_id`, { uid, owned })
        const page = await ok(await api(env, '/api/cards?rarity=L', { uid }), Page)
        assert.deepEqual([page.ownedCardIds, page.wishlistCardIds], [[owned], [wished]])
        const wish = await ok(await api(env, '/api/cards?wishlist=1', { uid }), Filtered)
        assert.deepEqual([wish.total, wish.cards.map((c) => c.id), wish.wishlistCardIds], [1, [wished], [wished]])
      },
    },
  ],
}
