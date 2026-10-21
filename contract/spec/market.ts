import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, failed, giveCards, Iso, makeUser, noSession, ok, psql, Rarity } from '../users.ts'

// Objet Auction de wm.auction_json (M3-19, P5) : les 21 colonnes de public.auctions et 7 clés calculées.
const Auction = z.object({
  id: z.uuid(), seller_id: z.uuid(), card_id: z.uuid(), user_card_id: z.uuid(),
  snapshot_rarity: Rarity, snapshot_atk: z.int().nullable(), snapshot_def: z.int().nullable(), snapshot_search_document: z.string().nullable(),
  is_shiny: z.boolean(), base_amount: z.int(), listing_base_amount: z.int(), base_repriced_at: Iso.nullable(),
  current_bid: z.int().nullable(), current_bidder_id: z.uuid().nullable(), bids_count: z.int(), final_price: z.int().nullable(),
  status: z.enum(['active', 'settled_sold', 'settled_unsold', 'cancelled']), end_at: Iso, created_at: Iso, settled_at: Iso.nullable(),
  winner_id: z.uuid().nullable(),
  seller: z.object({ id: z.uuid(), username: z.string() }),
  current_bidder: z.object({ username: z.string() }).nullable(),
  card: z.object({
    id: z.uuid(), wikipedia_title: z.string(), wikipedia_url: z.string(), rarity: Rarity, category: z.string().nullable(),
    image_url: z.string().nullable(), hide_image: z.boolean(), nsfw_image: z.boolean(), atk: z.int(), def: z.int(),
    q_score: z.number().nullable(), pageviews: z.int(),
  }),
  effective_bid: z.int(), bid_count: z.int(), buyer_id: z.uuid().nullable(), min_next_bid: z.int().nullable(),
}).loose()
// Réponses par joueur, /settle compris (M3-19, P11).
const AuctionOwned = Auction.extend({ owned: z.boolean() })
const Created = z.object({ auction_id: z.uuid(), id: z.uuid(), end_at: Iso }).loose()
const Bid = z.object({ current_bid: z.int(), bidder_balance: z.int(), balance: z.int(), end_at: Iso, min_next_bid: z.int() })
const Copies = z.object({ collection: z.array(z.object({ id: z.uuid(), card_id: z.uuid() })) })
const HUMAN = 'Vérification anti-bot requise pour continuer.'

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const send = (env: ContractEnv, method: string, path: string, uid?: string, body?: unknown, headers?: Record<string, string>) =>
  api(env, path, { method, uid, body, headers })
const idem = () => ({ 'Idempotency-Key': randomUUID() })
const at = (id: string, action = '') => `/api/marketplace/${id}${action && `/${action}`}`
const copies = async (env: ContractEnv, uid: string) => (await ok(await api(env, '/api/my-collection', { uid }), Copies)).collection
const humanCheck = async (env: ContractEnv, uid: string) =>
  assert.equal((await send(env, 'POST', '/api/human-check', uid, { token: 'dev-bypass' })).status, 200)

async function refused(res: Response, status: number, error: string, code?: string) {
  const body = await failed(res, status, code)
  assert.equal(body.error, error)
  return body
}

// ok() attend 200 (users.ts) ; la mise en vente répond 201 (M3-14).
async function created(res: Response) {
  const text = await res.text()
  assert.equal(res.status, 201, text.slice(0, 500))
  return Created.parse(JSON.parse(text))
}

// Joueur vérifié (anti-bot levé) et ses copies C, des cartes différentes (giveCards).
function seller(env: ContractEnv, { cards = 1, ...user }: Parameters<typeof makeUser>[1] & { cards?: number } = {}) {
  const { uid } = makeUser(db(env), { ...user, humanVerified: true })
  return { uid, copies: giveCards(db(env), uid, 'C', cards) }
}
const bidder = (env: ContractEnv, balance = 1000) => makeUser(db(env), { balance, humanVerified: true }).uid

// Mise en vente par SQL ; compteur de rafale remis à zéro comme pg_temp.listing (sinon la 5e retire la vérification, P3).
function listed(env: ContractEnv, sellerUid: string, cardOrCopyId: string, base = 100, minutes = 60): string {
  return sql(env, `select wm.create_auction(:'uid', :'card', :'base'::int, :'minutes'::int) ->> 'id';
update wm.user_state set list_window_count = 0 where user_id = :'uid'`,
  { uid: sellerUid, card: cardOrCopyId, base: String(base), minutes: String(minutes) })
}
const expire = (env: ContractEnv, id: string) =>
  sql(env, `update public.auctions set end_at = now() - interval '1 minute' where id = :'id'`, { id })
const bid = async (env: ContractEnv, uid: string, id: string, amount: number, headers?: Record<string, string>) =>
  ok(await send(env, 'POST', at(id, 'bid'), uid, { amount }, headers), Bid)

const sell = (env: ContractEnv, uid: string | undefined, body: unknown, headers?: Record<string, string>) =>
  send(env, 'POST', '/api/marketplace', uid, body, headers)
const offer = (card_id: string) => ({ card_id, base_amount: 10, duration_minutes: 60 })

export const createAuction: RouteSpec = {
  method: 'POST',
  path: '/api/marketplace',
  source: 'R§3.5',
  confidence: 'conf.',
  cases: [
    noSession('POST', '/api/marketplace'),
    {
      name: 'non vérifié → 403 human_verification_required ; human-check, puis la même Idempotency-Key → 201 (le 403 n\'a rien gardé, P27)',
      run: async (env) => {
        const { uid } = makeUser(db(env))
        const [copy] = giveCards(db(env), uid, 'C')
        const key = idem()
        const denied = await refused(await sell(env, uid, offer(copy), key), 403, HUMAN, 'human_verification_required')
        assert.equal(denied.human_verification_required, true)
        await humanCheck(env, uid)
        await created(await sell(env, uid, offer(copy), key))
      },
    },
    {
      name: 'id de copie → 201 { auction_id, id, end_at } (fin dans 60 min) ; la copie quitte /api/my-collection',
      run: async (env) => {
        const { uid, copies: [copy] } = seller(env)
        const res = await created(await sell(env, uid, offer(copy)))
        assert.equal(res.id, res.auction_id)
        assert.ok(Math.abs(Date.parse(res.end_at) - Date.now() - 3_600_000) < 60_000, res.end_at)
        assert.deepEqual(await copies(env, uid), [])
      },
    },
    {
      name: 'id catalogue → la copie la plus ancienne de cette carte',
      run: async (env) => {
        const { uid } = makeUser(db(env), { humanVerified: true })
        const card = sql(env, `select id from public.cards where rarity = 'C' order by wikipedia_title limit 1`)
        const copy = (days: number) => sql(env, `insert into public.user_cards
  (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def, obtained_at)
select :'uid', id, wikipedia_title, rarity, category, atk, def, now() - make_interval(days => :'days'::int) from public.cards where id = :'card'
returning id`, { uid, card, days: String(days) })
        const newer = copy(1)
        const older = copy(2)
        const { id } = await created(await sell(env, uid, offer(card)))
        assert.equal(sql(env, `select user_card_id from public.auctions where id = :'id'`, { id }), older)
        assert.deepEqual((await copies(env, uid)).map((c) => c.id), [newer])
      },
    },
    {
      name: 'copie d\'un autre → 403 42501 « Vous ne possédez pas cette carte »',
      run: async (env) => {
        const other = seller(env)
        const { uid } = makeUser(db(env), { humanVerified: true })
        await refused(await sell(env, uid, offer(other.copies[0])), 403, 'Vous ne possédez pas cette carte', '42501')
      },
    },
    {
      name: 'duration_minutes 45 → 400 « Durée d\'enchère invalide » ; base_amount 0 → 400 ; {} → 400 invalid_request',
      run: async (env) => {
        const { uid, copies: [copy] } = seller(env)
        await refused(await sell(env, uid, { ...offer(copy), duration_minutes: 45 }), 400, 'Durée d\'enchère invalide', 'invalid_request')
        await refused(await sell(env, uid, { ...offer(copy), base_amount: 0 }), 400,
          'La mise de départ doit être d\'au moins 1 wikibidou', 'invalid_request')
        await failed(await sell(env, uid, {}), 400, 'invalid_request')
      },
    },
    {
      name: 'gratuit avec 5 ventes actives → la 6e → 409 « Limite de 5 enchères actives atteinte », sans code',
      run: async (env) => {
        const { uid, copies: mine } = seller(env, { cards: 6 })
        for (const copy of mine.slice(0, 5)) listed(env, uid, copy)
        await refused(await sell(env, uid, offer(mine[5])), 409, 'Limite de 5 enchères actives atteinte')
      },
    },
    {
      name: 'même Idempotency-Key deux fois → corps identiques, une seule enchère',
      run: async (env) => {
        const { uid, copies: [copy] } = seller(env)
        const key = idem()
        const first = await created(await sell(env, uid, offer(copy), key))
        assert.deepEqual(await created(await sell(env, uid, offer(copy), key)), first)
        assert.equal(sql(env, `select count(*) from public.auctions where seller_id = :'uid'`, { uid }), '1')
      },
    },
  ],
}

export const placeBid: RouteSpec = {
  method: 'POST',
  path: '/api/marketplace/{auctionId}/bid',
  source: 'R§3.5',
  confidence: 'conf.',
  cases: [
    noSession('POST', at(randomUUID(), 'bid')),
    {
      name: 'auctionId=abc → 400 invalid_request ; id inconnu → 404 « Enchère introuvable »',
      run: async (env) => {
        const uid = bidder(env)
        await failed(await send(env, 'POST', at('abc', 'bid'), uid, { amount: 10 }), 400, 'invalid_request')
        await refused(await send(env, 'POST', at(randomUUID(), 'bid'), uid, { amount: 10 }), 404, 'Enchère introuvable')
      },
    },
    {
      name: 'miseur non vérifié → 403 human_verification_required ; human-check, puis la même Idempotency-Key → 200',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const { uid } = makeUser(db(env), { balance: 1000 })
        const key = idem()
        const denied = await refused(await send(env, 'POST', at(id, 'bid'), uid, { amount: 100 }, key), 403, HUMAN, 'human_verification_required')
        assert.equal(denied.human_verification_required, true)
        await humanCheck(env, uid)
        assert.equal((await bid(env, uid, id, 100, key)).current_bid, 100)
      },
    },
    {
      name: 'A mise la base (100) → 200, min_next_bid 110 ; B 109 → 409 bid_too_low { min: 110 } ; B 110 → 200 et A remboursé',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const [a, b] = [bidder(env), bidder(env)]
        const first = await bid(env, a, id, 100)
        assert.deepEqual([first.current_bid, first.bidder_balance, first.balance, first.min_next_bid], [100, 900, 900, 110])
        const low = await refused(await send(env, 'POST', at(id, 'bid'), b, { amount: 109 }), 409,
          'Mise trop basse (minimum 110 wikibidous)', 'bid_too_low')
        assert.equal(low.min, 110)
        assert.equal((await bid(env, b, id, 110)).current_bid, 110)
        assert.deepEqual(await ok(await api(env, '/api/wikibidous', { uid: a }), z.unknown()), { balance: 1000 })
      },
    },
    {
      name: 'le vendeur → 409 « Tu ne peux pas enchérir sur ta propre vente » ; le meneur rejoue → 409 « Tu es déjà en tête »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const b = bidder(env)
        await bid(env, b, id, 100)
        await refused(await send(env, 'POST', at(id, 'bid'), s.uid, { amount: 200 }), 409, 'Tu ne peux pas enchérir sur ta propre vente')
        await refused(await send(env, 'POST', at(id, 'bid'), b, { amount: 200 }), 409, 'Tu es déjà en tête')
      },
    },
    {
      name: 'solde trop bas → 409 insufficient_balance ; end_at passé → 409 « Cette enchère est terminée »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const uid = bidder(env, 50)
        await refused(await send(env, 'POST', at(id, 'bid'), uid, { amount: 100 }), 409, 'Solde insuffisant', 'insufficient_balance')
        expire(env, id)
        await refused(await send(env, 'POST', at(id, 'bid'), uid, { amount: 100 }), 409, 'Cette enchère est terminée')
      },
    },
  ],
}

export const cancelAuction: RouteSpec = {
  method: 'DELETE',
  path: '/api/marketplace/{auctionId}',
  source: 'R§3.5',
  confidence: 'conf.',
  cases: [
    noSession('DELETE', at(randomUUID())),
    {
      name: 'inconnue → 404 ; un autre → 403 « Seul le vendeur… » ; avec une mise → 409 « Une enchère en cours ne peut pas être retirée »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const other = bidder(env)
        await refused(await send(env, 'DELETE', at(randomUUID()), s.uid), 404, 'Enchère introuvable')
        await refused(await send(env, 'DELETE', at(id), other), 403, 'Seul le vendeur peut modifier cette enchère')
        await bid(env, other, id, 100)
        await refused(await send(env, 'DELETE', at(id), s.uid), 409, 'Une enchère en cours ne peut pas être retirée')
      },
    },
    {
      name: 'sans mise → 200 { ok: true, user_card_id } ; la copie revient dans /api/my-collection sous cet id neuf (M3-7)',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const res = await ok(await send(env, 'DELETE', at(id), s.uid), z.object({ ok: z.literal(true), user_card_id: z.uuid() }))
        assert.notEqual(res.user_card_id, s.copies[0])
        assert.deepEqual((await copies(env, s.uid)).map((c) => c.id), [res.user_card_id])
      },
    },
  ],
}

export const settleAuction: RouteSpec = {
  method: 'POST',
  path: '/api/marketplace/{auctionId}/settle',
  source: 'R§3.5',
  confidence: 'prob.',
  cases: [
    noSession('POST', at(randomUUID(), 'settle')),
    {
      name: 'non échue → 409 « L\'enchère n\'est pas encore terminée » ; inconnue → 404 « Enchère introuvable »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        await refused(await send(env, 'POST', at(id, 'settle'), s.uid), 409, 'L\'enchère n\'est pas encore terminée')
        await refused(await send(env, 'POST', at(randomUUID(), 'settle'), s.uid), 404, 'Enchère introuvable')
      },
    },
    {
      name: 'échue, par le gagnant → 200 { auction } settled_sold, owned true, copie chez lui ; second appel → 200, même statut',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const winner = bidder(env)
        await bid(env, winner, id, 100)
        expire(env, id)
        const Settled = z.object({ auction: AuctionOwned })
        const { auction } = await ok(await send(env, 'POST', at(id, 'settle'), winner), Settled)
        assert.deepEqual([auction.id, auction.status, auction.owned, auction.winner_id, auction.final_price], [id, 'settled_sold', true, winner, 100])
        assert.deepEqual((await copies(env, winner)).map((c) => c.card_id), [auction.card_id])
        assert.equal((await ok(await send(env, 'POST', at(id, 'settle'), winner), Settled)).auction.status, 'settled_sold')
      },
    },
  ],
}

export const repriceAuction: RouteSpec = {
  method: 'POST',
  path: '/api/marketplace/{auctionId}/reprice',
  source: 'R§3.5',
  confidence: 'prob.',
  cases: [
    noSession('POST', at(randomUUID(), 'reprice')),
    {
      name: 'inconnue → 404 ; un autre → 403 ; à la création → 409 « Le prix ne peut être baissé qu\'après la moitié de la durée »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0], 10, 60)
        const reprice = (uid: string, auctionId: string) => send(env, 'POST', at(auctionId, 'reprice'), uid, { new_base_amount: 5 })
        await refused(await reprice(s.uid, randomUUID()), 404, 'Enchère introuvable')
        await refused(await reprice(bidder(env), id), 403, 'Seul le vendeur peut modifier cette enchère')
        await refused(await reprice(s.uid, id), 409, 'Le prix ne peut être baissé qu\'après la moitié de la durée')
      },
    },
    {
      name: 'base 10, 31 min passées sur 60 : 6 → 400 « … entre 1 et 5 wikibidous » ; 5 → 200 ; second appel → 409 « déjà baissé »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0], 10, 60)
        sql(env, `update public.auctions set created_at = created_at - interval '31 minutes' where id = :'id'`, { id })
        const reprice = (n: number) => send(env, 'POST', at(id, 'reprice'), s.uid, { new_base_amount: n })
        await refused(await reprice(6), 400, 'Le nouveau prix doit être compris entre 1 et 5 wikibidous', 'invalid_request')
        await ok(await reprice(5), z.object({ ok: z.literal(true), base_amount: z.literal(5), base_repriced_at: Iso }))
        await refused(await reprice(4), 409, 'Le prix a déjà été baissé une fois')
      },
    },
  ],
}

export const marketWrites: RouteSpec[] = [createAuction, placeBid, cancelAuction, settleAuction, repriceAuction]
