import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { CRON_SECRET } from '../harness.ts'
import { api, failed, Iso, makeUser, noSession, ok, psql, Rarity } from '../users.ts'

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

const firstCard = async (env: ContractEnv, uid: string) => (await ok(await api(env, '/api/cards', { uid }), Page)).cards[0]
const revalidate = (env: ContractEnv) => fetch(`${env.plain}/api/cron/revalidate`, { method: 'POST', headers: { 'x-cron-secret': CRON_SECRET } })

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
      name: 'q=a → 400 « La recherche demande au moins 2 caractères » ; q=%00ab → 400 « Caractère invalide » (zod : un \\0 atteignant PG serait un 22P05, donc un 500)',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        // Deux lectures : la seconde sort du cache, qui garde le code et le détail du P0001 (P14).
        for (let i = 0; i < 2; i++) {
          const body = await failed(await api(env, '/api/cards?q=a', { uid }), 400, 'invalid_request')
          assert.equal(body.error, 'La recherche demande au moins 2 caractères')
        }
        assert.equal((await failed(await api(env, '/api/cards?q=%00ab', { uid }), 400, 'invalid_request')).error, 'Caractère invalide')
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
      name: 'ownedCardIds et wishlistCardIds reflètent une copie et un souhait de la page ; wishlist=1 ne rend que le souhait',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        // Cartes prises dans la page demandée : le cas tient avec n'importe quel catalogue.
        const [owned, wished] = (await ok(await api(env, '/api/cards', { uid }), Page)).cards.map((c) => c.id)
        psql(env.backend.databaseUrl, `insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where id = :'owned';
insert into public.wishlist_items (user_id, card_id) values (:'uid', :'wished')`, { uid, owned, wished })
        const page = await ok(await api(env, '/api/cards', { uid }), Page)
        assert.deepEqual([page.ownedCardIds, page.wishlistCardIds], [[owned], [wished]])
        const wish = await ok(await api(env, '/api/cards?wishlist=1', { uid }), Filtered)
        assert.deepEqual([wish.total, wish.cards.map((c) => c.id), wish.wishlistCardIds], [1, [wished], [wished]])
      },
    },
    {
      name: 'page partagée en cache jusqu\'à POST /api/cron/revalidate (M2-14, M2-15)',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const { id, summary: original } = await firstCard(env, uid)
        // psql rogne sa sortie : un résumé nul ou bordé de blancs ne se relirait ni ne se restaurerait à l'identique.
        assert.ok(original && original === original.trim(), `résumé inutilisable pour ce cas : ${JSON.stringify(original)}`)
        const edit = (summary: string) => psql(env.backend.databaseUrl,
          `update public.cards set summary = :'summary' where id = :'id' returning summary`, { id, summary })
        const fresh = edit(`${original} (revalidé)`)
        try {
          assert.equal((await firstCard(env, uid)).summary, original)
          assert.equal((await revalidate(env)).status, 200)
          // Profil max : la première lecture sert encore la page périmée pendant que le cache se recharge.
          const end = Date.now() + 5_000
          let seen: string | null = original
          while (seen !== fresh && Date.now() < end) {
            await sleep(250)
            seen = (await firstCard(env, uid)).summary
          }
          assert.equal(seen, fresh)
        } finally {
          // Sans assertion : un échec ici masquerait celui du cas.
          edit(original)
          await revalidate(env)
        }
      },
    },
  ],
}
