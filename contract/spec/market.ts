import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
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
const Settled = z.object({ auction: AuctionOwned })
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
export function seller(env: ContractEnv, { cards = 1, ...user }: Parameters<typeof makeUser>[1] & { cards?: number } = {}) {
  const { uid } = makeUser(db(env), { ...user, humanVerified: true })
  return { uid, copies: giveCards(db(env), uid, 'C', cards) }
}
const bidder = (env: ContractEnv, balance = 1000) => makeUser(db(env), { balance, humanVerified: true }).uid

// Mise en vente par SQL ; compteur de rafale remis à zéro comme pg_temp.listing (sinon la 5e retire la vérification, P3).
export function listed(env: ContractEnv, sellerUid: string, cardOrCopyId: string, base = 100, minutes = 60): string {
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
      name: 'miseur non vérifié → 403 human_verification_required ; human-check, puis la même Idempotency-Key → 200 ; rejouée → même corps, un seul débit',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const { uid } = makeUser(db(env), { balance: 1000 })
        const key = idem()
        const denied = await refused(await send(env, 'POST', at(id, 'bid'), uid, { amount: 100 }, key), 403, HUMAN, 'human_verification_required')
        assert.equal(denied.human_verification_required, true)
        await humanCheck(env, uid)
        const done = await bid(env, uid, id, 100, key)
        assert.equal(done.current_bid, 100)
        assert.deepEqual(await bid(env, uid, id, 100, key), done)
        assert.deepEqual(await ok(await api(env, '/api/wikibidous', { uid }), z.unknown()), { balance: 900 })
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
      name: 'abc → 400 invalid_request ; inconnue → 404 ; un autre → 403 « Seul le vendeur… » ; avec une mise → 409 « … ne peut pas être retirée »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const other = bidder(env)
        await failed(await send(env, 'DELETE', at('abc'), s.uid), 400, 'invalid_request')
        await refused(await send(env, 'DELETE', at(randomUUID()), s.uid), 404, 'Enchère introuvable')
        await refused(await send(env, 'DELETE', at(id), other), 403, 'Seul le vendeur peut modifier cette enchère')
        await bid(env, other, id, 100)
        await refused(await send(env, 'DELETE', at(id), s.uid), 409, 'Une enchère en cours ne peut pas être retirée')
      },
    },
    {
      name: 'sans mise → 200 { ok: true, user_card_id } ; la copie revient sous cet id neuf (M3-7) ; même Idempotency-Key → même corps',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const key = idem()
        const cancel = async () => ok(await send(env, 'DELETE', at(id), s.uid, undefined, key), z.object({ ok: z.literal(true), user_card_id: z.uuid() }))
        const res = await cancel()
        assert.notEqual(res.user_card_id, s.copies[0])
        assert.deepEqual((await copies(env, s.uid)).map((c) => c.id), [res.user_card_id])
        assert.deepEqual(await cancel(), res)
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
      name: 'abc → 400 invalid_request ; non échue → 409 « L\'enchère n\'est pas encore terminée » ; inconnue → 404 « Enchère introuvable »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        await failed(await send(env, 'POST', at('abc', 'settle'), s.uid), 400, 'invalid_request')
        await refused(await send(env, 'POST', at(id, 'settle'), s.uid), 409, 'L\'enchère n\'est pas encore terminée')
        await refused(await send(env, 'POST', at(randomUUID(), 'settle'), s.uid), 404, 'Enchère introuvable')
      },
    },
    {
      name: 'échue, par le gagnant → 200 { auction } settled_sold, owned true, copie chez lui ; second appel, du vendeur → settled_sold, owned false',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const winner = bidder(env)
        await bid(env, winner, id, 100)
        expire(env, id)
        const { auction } = await ok(await send(env, 'POST', at(id, 'settle'), winner), Settled)
        assert.deepEqual([auction.id, auction.status, auction.owned, auction.winner_id, auction.final_price], [id, 'settled_sold', true, winner, 100])
        assert.deepEqual((await copies(env, winner)).map((c) => c.card_id), [auction.card_id])
        const again = (await ok(await send(env, 'POST', at(id, 'settle'), s.uid), Settled)).auction
        assert.deepEqual([again.status, again.owned], ['settled_sold', false])
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
      name: 'abc → 400 ; inconnue → 404 ; un autre → 403 ; à la création → 409 « Le prix ne peut être baissé qu\'après la moitié de la durée »',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0], 10, 60)
        const reprice = (uid: string, auctionId: string) => send(env, 'POST', at(auctionId, 'reprice'), uid, { new_base_amount: 5 })
        await failed(await reprice(s.uid, 'abc'), 400, 'invalid_request')
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

// Lectures (M3-19). Chaque cas qui lit la liste partagée met en vente sa propre carte, au titre unique, et filtre par ce titre (q).
const List = z.object({ auctions: z.array(AuctionOwned), hasMore: z.boolean(), total: z.int() })
const Detail = z.object({
  auction: AuctionOwned,
  bids: z.array(z.object({ amount: z.int(), placed_at: Iso, created_at: Iso, bidder: z.object({ username: z.string() }) })),
})
const Sale = z.strictObject({ id: z.uuid(), rarity: Rarity, is_shiny: z.boolean(), final_price: z.int(), settled_at: Iso })
const Mine = z.object({
  mine: z.literal(true), selling: z.array(AuctionOwned), won: z.array(AuctionOwned), history: z.array(AuctionOwned),
  bidding: z.array(AuctionOwned.extend({ my_last_bid: z.int(), my_state: z.enum(['leading', 'outbid', 'won', 'lost']) })),
  counts: z.object({ selling: z.int(), bidding: z.int(), won: z.int(), history: z.int() }),
  wonHasMore: z.boolean(), historyHasMore: z.boolean(), sellingCount: z.int(), maxConcurrentAuctions: z.int(),
})

const title = () => `Zz marché contrat ${randomUUID().slice(-12)}`
// Carte du catalogue hors pool (25_pool.test.sql) : aucune autre enchère ne la porte.
const cardOf = (env: ContractEnv, wikipediaTitle: string, rarity = 'C') =>
  sql(env, `insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
values (:'t', 'https://fr.wikipedia.org/wiki/' || replace(:'t', ' ', '_'), :'r', 100, 100, 'Essai', 'Résumé') returning id`, { t: wikipediaTitle, r: rarity })
const copyOf = (env: ContractEnv, uid: string, card: string) =>
  sql(env, `insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where id = :'card' returning id`, { uid, card })
// La carte du cas n'est pas dans le seed (giveCards) : une copie posée à la main, vendue par l'id catalogue (M3-14).
function sellNew(env: ContractEnv, uid: string, card: string, base = 100, minutes = 60): string {
  copyOf(env, uid, card)
  return listed(env, uid, card, base, minutes)
}

// Clé répétée (rarity) : passer des paires.
const list = async (env: ContractEnv, uid: string, query: ConstructorParameters<typeof URLSearchParams>[0]) =>
  ok(await api(env, `/api/marketplace?${new URLSearchParams(query)}`, { uid }), List)
const ids = (auctions: Array<{ id: string }>) => auctions.map((a) => a.id)
async function statusOf(res: Response): Promise<number> {
  await res.text()
  return res.status
}
// Relit toutes les 250 ms jusqu'à `done` ou `ms` écoulées (profils cacheLife, M3-22) ; renvoie la dernière lecture.
async function poll<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < end) {
    await sleep(250)
    v = await read()
  }
  return v
}
const salesOf = (card: string, scope = '') => `/api/marketplace/cards/${card}/sales${scope && `?scope=${scope}`}`

// 11 et 12 : la moyenne 11,5 éprouve l'arrondi du résumé (round → 12).
async function twoSales(env: ContractEnv): Promise<string> {
  const card = cardOf(env, title(), 'R')
  const uid = bidder(env, 0)
  for (const price of [11, 12]) {
    const id = sellNew(env, uid, card, price)
    const b = bidder(env)
    await bid(env, b, id, price)
    expire(env, id)
    await ok(await send(env, 'POST', at(id, 'settle'), b), Settled)
  }
  return card
}

export const marketList: RouteSpec = {
  method: 'GET',
  path: '/api/marketplace',
  source: 'R§3.5',
  confidence: 'conf.',
  cases: [
    noSession('GET', '/api/marketplace'),
    {
      name: '→ { auctions: Auction[], hasMore, total } ; owned true pour l\'observateur qui a une copie, false pour un autre (même page partagée)',
      run: async (env) => {
        const t = title()
        const card = cardOf(env, t)
        const id = sellNew(env, bidder(env, 0), card)
        const owner = makeUser(db(env)).uid
        copyOf(env, owner, card)
        const page = await list(env, owner, { q: t })
        assert.deepEqual([ids(page.auctions), page.auctions[0].owned, page.hasMore, page.total], [[id], true, false, 1])
        assert.equal((await list(env, makeUser(db(env)).uid, { q: t })).auctions[0].owned, false)
      },
    },
    {
      name: '400 invalid_request, lus deux fois : page=0 et \\0 dans q ou sort (zod) ; sort=xyz « Tri inconnu » et q=a « … au moins 2 caractères » (SQL, relus en cache)',
      run: async (env) => {
        const uid = makeUser(db(env)).uid
        for (const [query, error] of [['page=0', 'La page commence à 1'], ['q=%00ab', 'Caractère invalide'], ['sort=%00', 'Caractère invalide'],
          ['sort=xyz', 'Tri inconnu'], ['q=a', 'La recherche demande au moins 2 caractères']] as const) {
          for (let i = 0; i < 2; i++) await refused(await api(env, `/api/marketplace?${query}`, { uid }), 400, error, 'invalid_request')
        }
      },
    },
    {
      name: 'q sans accents trouve le titre accentué ; rarity répétable ; card_id strict',
      run: async (env) => {
        const t = title()
        const vendor = bidder(env, 0)
        const [r, sr, c] = ['R', 'SR', 'C'].map((rarity) => cardOf(env, `${t} ${rarity}`, rarity))
        const [onR, onSR, onC] = [r, sr, c].map((card) => sellNew(env, vendor, card))
        const uid = makeUser(db(env)).uid
        const plain = t.replace('é', 'e').toUpperCase()
        assert.deepEqual(ids((await list(env, uid, { q: plain })).auctions).sort(), [onR, onSR, onC].sort())
        assert.deepEqual(ids((await list(env, uid, [['q', t], ['rarity', 'R'], ['rarity', 'SR']])).auctions).sort(), [onR, onSR].sort())
        assert.deepEqual(ids((await list(env, uid, { card_id: c })).auctions), [onC])
      },
    },
    {
      name: 'sort=ending_soon : une enchère échue non réglée en tête (recent : la plus récente)',
      run: async (env) => {
        const t = title()
        const vendor = bidder(env, 0)
        const due = sellNew(env, vendor, cardOf(env, `${t} a`))
        expire(env, due)
        const soon = sellNew(env, vendor, cardOf(env, `${t} b`), 100, 10)
        const uid = makeUser(db(env)).uid
        assert.deepEqual(ids((await list(env, uid, { q: t, sort: 'ending_soon' })).auctions), [due, soon])
        assert.deepEqual(ids((await list(env, uid, { q: t, sort: 'recent' })).auctions), [soon, due])
      },
    },
    {
      name: '51 enchères actives d\'une carte, limit=100 → 50, hasMore, total 51',
      run: async (env) => {
        const t = title()
        const card = cardOf(env, t)
        // 11 vendeurs gratuits à 5 ventes au plus : la limite de M3-10, et la 5e de la rafale passe encore (P3).
        const uids = Array.from({ length: 11 }, () => bidder(env, 0))
        sql(env, `insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select (string_to_array(:'uids', ','))[i / 5 + 1]::uuid, id, wikipedia_title, rarity, category, atk, def from public.cards, generate_series(0, 50) i
where id = :'card';
select count(wm.create_auction(user_id, id, 100, 60)) from public.user_cards where card_id = :'card'`, { uids: uids.join(','), card })
        const page = await list(env, makeUser(db(env)).uid, { q: t, limit: '100' })
        assert.deepEqual([page.auctions.length, page.hasMore, page.total], [50, true, 51])
      },
    },
    {
      name: 'mine=1 → mine, selling, bidding (my_state leading puis outbid, won), won, history, counts, *HasMore, sellingCount, max',
      run: async (env) => {
        const other = seller(env, { cards: 2 })
        const [x, y] = other.copies.map((copy) => listed(env, other.uid, copy))
        const me = seller(env, { cards: 2, balance: 1000 })
        const [selling, cancelled] = me.copies.map((copy) => listed(env, me.uid, copy))
        await ok(await send(env, 'DELETE', at(cancelled), me.uid), z.unknown())
        await bid(env, me.uid, x, 100)
        await bid(env, me.uid, y, 100)
        expire(env, y)
        await ok(await send(env, 'POST', at(y, 'settle'), me.uid), Settled)
        const mine = async () => ok(await api(env, '/api/marketplace?mine=1', { uid: me.uid }), Mine)
        const m = await mine()
        assert.deepEqual([ids(m.selling), ids(m.won), ids(m.history), m.counts, m.wonHasMore, m.historyHasMore, m.sellingCount, m.maxConcurrentAuctions],
          [[selling], [y], [cancelled], { selling: 1, bidding: 2, won: 1, history: 1 }, false, false, 1, 5])
        assert.deepEqual(m.bidding.map((a) => [a.id, a.my_state, a.my_last_bid]), [[y, 'won', 100], [x, 'leading', 100]])
        await bid(env, bidder(env), x, 110)
        assert.deepEqual((await mine()).bidding.map((a) => a.my_state), ['won', 'outbid'])
      },
    },
    {
      name: 'cache : la réponse de la mise porte le nouveau current_bid, la liste l\'affiche en moins de 5 s (profil market, 3 s au plus)',
      run: async (env) => {
        const t = title()
        const id = sellNew(env, bidder(env, 0), cardOf(env, t))
        const uid = bidder(env)
        assert.equal((await list(env, uid, { q: t })).auctions[0].current_bid, null)
        assert.equal((await bid(env, uid, id, 100)).current_bid, 100)
        const t0 = Date.now()
        const seen = await poll(async () => (await list(env, uid, { q: t })).auctions[0].current_bid, (v) => v === 100, 5_000)
        assert.equal(seen, 100, `liste encore périmée après ${Date.now() - t0} ms`)
      },
    },
  ],
}

export const marketMine: RouteSpec = {
  method: 'GET',
  path: '/api/marketplace/mine',
  source: 'R§3.5',
  confidence: 'conf.',
  cases: [
    noSession('GET', '/api/marketplace/mine'),
    {
      name: '→ { sellingCount: 1, maxConcurrentAuctions: 5, auctions: [{ id, card_id, user_card_id }] } ; Pro → maxConcurrentAuctions 10',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const card_id = sql(env, `select card_id from public.auctions where id = :'id'`, { id })
        const mine = async (uid: string) => ok(await api(env, '/api/marketplace/mine', { uid }), z.unknown())
        assert.deepEqual(await mine(s.uid), { sellingCount: 1, maxConcurrentAuctions: 5, auctions: [{ id, card_id, user_card_id: s.copies[0] }] })
        assert.deepEqual(await mine(makeUser(db(env), { pro: true }).uid), { sellingCount: 0, maxConcurrentAuctions: 10, auctions: [] })
      },
    },
  ],
}

export const auctionDetail: RouteSpec = {
  method: 'GET',
  path: '/api/marketplace/{auctionId}',
  source: 'R§3.5',
  confidence: 'conf.',
  cases: [
    noSession('GET', at(randomUUID())),
    {
      name: '→ { auction, bids } : plus récente d\'abord, bidder.username du miseur, created_at = placed_at',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const [a, b] = [0, 1].map(() => makeUser(db(env), { balance: 1000, humanVerified: true }))
        await bid(env, a.uid, id, 100)
        await bid(env, b.uid, id, 110)
        const { auction, bids } = await ok(await api(env, at(id), { uid: a.uid }), Detail)
        assert.deepEqual([auction.id, auction.current_bid, auction.current_bidder?.username, auction.owned], [id, 110, b.username, false])
        assert.deepEqual(bids.map((x) => [x.amount, x.bidder.username]), [[110, b.username], [100, a.username]])
        assert.ok(bids.every((x) => x.created_at === x.placed_at))
      },
    },
    {
      name: 'abc → 400 ; inconnue → 404 « Enchère introuvable » ; après DELETE → 404 en moins de 4 s (profil auction, 2 s au plus)',
      run: async (env) => {
        const uid = makeUser(db(env)).uid
        await failed(await api(env, at('abc'), { uid }), 400, 'invalid_request')
        await refused(await api(env, at(randomUUID()), { uid }), 404, 'Enchère introuvable')
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        await ok(await api(env, at(id), { uid }), Detail)
        await ok(await send(env, 'DELETE', at(id), s.uid), z.unknown())
        const t0 = Date.now()
        const status = await poll(async () => statusOf(await api(env, at(id), { uid })), (v) => v === 404, 4_000)
        assert.equal(status, 404, `détail encore servi après ${Date.now() - t0} ms`)
        await refused(await api(env, at(id), { uid }), 404, 'Enchère introuvable')
      },
    },
    {
      name: 'règlement sans clic : échue avec une mise, premier GET (cache vide) → settled_sold, copie chez le gagnant, vendeur crédité',
      run: async (env) => {
        const s = seller(env)
        const id = listed(env, s.uid, s.copies[0])
        const winner = bidder(env)
        await bid(env, winner, id, 100)
        expire(env, id)
        const { auction } = await ok(await api(env, at(id), { uid: winner }), Detail)
        assert.deepEqual([auction.status, auction.winner_id, auction.final_price, auction.owned], ['settled_sold', winner, 100, true])
        assert.deepEqual((await copies(env, winner)).map((c) => c.card_id), [auction.card_id])
        assert.deepEqual(await ok(await api(env, '/api/wikibidous', { uid: s.uid }), z.unknown()), { balance: 100 })
      },
    },
  ],
}

export const cardSales: RouteSpec = {
  method: 'GET',
  path: '/api/marketplace/cards/{cardId}/sales',
  source: 'R§3.5',
  confidence: 'conf.',
  cases: [
    noSession('GET', salesOf(randomUUID(), 'summary')),
    {
      name: 'scope=summary après deux ventes R à 11 et 12 → { summary: { R: { average: 12, count: 2 } } } (round(11,5) = 12)',
      run: async (env) => {
        const card = await twoSales(env)
        assert.deepEqual(await ok(await api(env, salesOf(card, 'summary'), { uid: makeUser(db(env)).uid }), z.unknown()),
          { summary: { R: { average: 12, count: 2 } } })
      },
    },
    {
      name: 'abc → 400 ; carte inconnue → 404 « Carte introuvable » (résumé et détail Pro)',
      run: async (env) => {
        const uid = makeUser(db(env), { pro: true }).uid
        await failed(await api(env, salesOf('abc', 'summary'), { uid }), 400, 'invalid_request')
        await refused(await api(env, salesOf(randomUUID(), 'summary'), { uid }), 404, 'Carte introuvable')
        await refused(await api(env, salesOf(randomUUID()), { uid }), 404, 'Carte introuvable')
      },
    },
    {
      name: 'sans scope : gratuit → 403 pro_required ; Pro → { sales, recent } de deux lignes { id, rarity, is_shiny, final_price, settled_at }',
      run: async (env) => {
        const card = await twoSales(env)
        await refused(await api(env, salesOf(card), { uid: makeUser(db(env)).uid }), 403, 'Fonction réservée aux membres Pro', 'pro_required')
        const res = await ok(await api(env, salesOf(card), { uid: makeUser(db(env), { pro: true }).uid }),
          z.object({ sales: z.array(Sale), recent: z.array(Sale) }))
        assert.deepEqual(res.sales.map((x) => [x.rarity, x.is_shiny, x.final_price]), [['R', false, 12], ['R', false, 11]])
        assert.deepEqual(res.recent, res.sales)
      },
    },
  ],
}

export const marketReads: RouteSpec[] = [marketList, marketMine, auctionDetail, cardSales]
