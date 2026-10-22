import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, failed, giveCards, idem, Iso, makeUser, noSession, ok, psql, Rarity, refused, send } from '../users.ts'
import { befriend } from './friends.ts'

// Objet Trade de wm.trade_json (P7) : les 13 colonnes de public.trades, ses deux joueurs, ses éléments et sa contre-offre.
const Who = z.object({ id: z.uuid(), username: z.string() }).loose()
const Trade = z.object({
  id: z.uuid(), status: z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired', 'countered']),
  initiator_id: z.uuid(), recipient_id: z.uuid(), initiator_wikibidous: z.int(), recipient_wikibidous: z.int(),
  parent_trade_id: z.uuid().nullable(), created_at: Iso, updated_at: Iso, accepted_at: Iso.nullable(), completed_at: Iso.nullable(),
  closed_at: Iso.nullable(), expires_at: Iso,
  initiator: Who, recipient: Who,
  items: z.array(z.object({
    offered_by: z.uuid(), card_id: z.uuid(), user_card_id: z.uuid(), snapshot_rarity: Rarity, is_shiny: z.boolean(),
    card: z.object({ id: z.uuid(), wikipedia_title: z.string(), image_url: z.string().nullable(), rarity: Rarity }).loose(),
  }).loose()),
  counter_trade_id: z.uuid().nullable(),
}).loose()
// Enveloppes strictes : une clé en plus au premier niveau ferait échouer le cas au lieu de disparaître avant le deepEqual.
const List = z.strictObject({ trades: z.array(Trade) })
const One = z.strictObject({ trade: Trade })
const Acted = z.strictObject({ status: Trade.shape.status, trade: Trade })
const INTERNAL = 'Erreur interne, réessaie dans un instant.'
const DONE = 'Cet échange n\'est plus en attente (déjà traité)'
const TZ = { 'x-wiki-calendar-tz': 'Europe/Paris' }

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const at = (id: string) => `/api/trades/${id}`
// Éléments [{user_card_id, card_id, offered_by}] de ces copies, une unité chacune, offertes par leur propriétaire.
const ITEMS = `(select jsonb_agg(jsonb_build_object('user_card_id', id, 'card_id', card_id, 'offered_by', user_id) order by id)
from public.user_cards where id = any (string_to_array(:'copies', ',')::uuid[]))`
const items = (env: ContractEnv, copies: string[]) =>
  JSON.parse(sql(env, `select ${ITEMS}`, { copies: copies.join(',') })) as Array<{ user_card_id: string; card_id: string; offered_by: string }>

type Player = { uid: string; username: string; c: string; pc: string }
// Joueur à 1 000 WB, une copie C et une PC.
function player(env: ContractEnv): Player {
  const user = makeUser(db(env), { balance: 1000 })
  return { ...user, c: giveCards(db(env), user.uid, 'C')[0], pc: giveCards(db(env), user.uid, 'PC')[0] }
}
// Deux joueurs amis (aussi pour rest.ts).
export function pair(env: ContractEnv): [Player, Player] {
  const [a, b] = [player(env), player(env)]
  befriend(env, a.uid, b.uid)
  return [a, b]
}
// Échange en attente de a vers b par wm.create_trade, par défaut la C de a contre la PC de b ; renvoie son id.
export function proposed(env: ContractEnv, a: Player, b: Player, { copies = [a.c, b.pc], iwb = 0, rwb = 0 } = {}): string {
  return sql(env, `select wm.create_trade(:'a', :'b', ${ITEMS}, :'iwb'::int, :'rwb'::int) ->> 'id'`,
    { a: a.uid, b: b.uid, copies: copies.join(','), iwb: String(iwb), rwb: String(rwb) })
}
// État complet de l'échange et de ses deux joueurs (M4-7).
const snap = (env: ContractEnv, id: string): unknown => JSON.parse(sql(env, `select tests.trade_snapshot(:'id')`, { id }))

const create = (env: ContractEnv, uid: string, body: unknown, headers?: Record<string, string>) =>
  send(env, 'POST', '/api/trades', uid, body, { ...TZ, ...headers })
const act = (env: ContractEnv, uid: string, id: string, action: string, headers?: Record<string, string>) =>
  send(env, 'PATCH', at(id), uid, { action }, { ...TZ, ...headers })
const copies = async (env: ContractEnv, uid: string) =>
  (await ok(await api(env, '/api/my-collection', { uid }), z.object({ collection: z.array(z.object({ id: z.uuid() }).loose()) })))
    .collection.map((c) => c.id)
const balance = async (env: ContractEnv, uid: string) =>
  (await ok(await api(env, '/api/wikibidous', { uid }), z.object({ balance: z.int() }))).balance

export const tradesList: RouteSpec = {
  method: 'GET',
  path: '/api/trades',
  source: 'R§3.6',
  confidence: 'conf.',
  cases: [
    noSession('GET', '/api/trades'),
    {
      name: 'un échange en attente et un refusé → { trades } au schéma Trade ; ?active=1&count=1 → le même corps ; celui de deux autres absent',
      run: async (env) => {
        const [a, b] = pair(env)
        const declined = proposed(env, a, b)
        sql(env, `select wm.trade_action(:'uid', :'id', 'decline')`, { uid: b.uid, id: declined })
        const pending = proposed(env, a, b)
        const [x, y] = pair(env)
        proposed(env, x, y)
        const list = await ok(await api(env, '/api/trades', { uid: a.uid }), List)
        assert.deepEqual(list.trades.map((t) => [t.id, t.status]), [[pending, 'pending'], [declined, 'declined']])
        assert.deepEqual(await ok(await api(env, '/api/trades?active=1&count=1', { uid: a.uid }), List), list)
      },
    },
  ],
}

export const tradeDetail: RouteSpec = {
  method: 'GET',
  path: '/api/trades/{tradeId}',
  source: 'R§3.6',
  confidence: 'prob.',
  cases: [
    noSession('GET', at(randomUUID())),
    {
      name: 'tradeId=abc → 400 invalid_request',
      run: async (env) => void (await failed(await api(env, at('abc'), { uid: makeUser(db(env)).uid }), 400, 'invalid_request')),
    },
    {
      name: 'chaque participant → { trade } (joueurs, éléments de l\'initiateur d\'abord) ; un étranger → 404 « Échange introuvable »',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b)
        for (const { uid } of [a, b]) {
          const { trade } = await ok(await api(env, at(id), { uid }), One)
          assert.deepEqual([trade.id, trade.status, trade.initiator, trade.recipient, trade.items.map((i) => [i.user_card_id, i.offered_by])],
            [id, 'pending', { id: a.uid, username: a.username }, { id: b.uid, username: b.username }, [[a.c, a.uid], [b.pc, b.uid]]])
        }
        await refused(await api(env, at(id), { uid: makeUser(db(env)).uid }), 404, 'Échange introuvable')
      },
    },
  ],
}

export const tradeCreate: RouteSpec = {
  method: 'POST',
  path: '/api/trades',
  source: 'R§3.6',
  confidence: 'prob.',
  cases: [
    noSession('POST', '/api/trades'),
    {
      name: '→ 200 Trade pending et une trade_received (M4-9, M4-12) ; un seul côté (une copie de A, 50 WB demandés) → 200',
      run: async (env) => {
        const [a, b] = pair(env)
        const body = { recipient_id: b.uid, items: items(env, [a.c, b.pc]), initiator_wikibidous: 10, recipient_wikibidous: 20 }
        const trade = await ok(await create(env, a.uid, body), Trade)
        assert.deepEqual([trade.status, trade.initiator_id, trade.recipient_id, trade.initiator_wikibidous, trade.recipient_wikibidous,
          trade.parent_trade_id, trade.items.map((i) => [i.user_card_id, i.offered_by])],
        ['pending', a.uid, b.uid, 10, 20, null, [[a.c, a.uid], [b.pc, b.uid]]])
        assert.deepEqual(JSON.parse(sql(env, `select jsonb_agg(jsonb_build_object('type', type, 'data', data)) from public.notifications
where user_id = :'uid'`, { uid: b.uid })), [{ type: 'trade_received', data: { trade_id: trade.id, user_id: a.uid, username: a.username } }])
        const one = await ok(await create(env, a.uid, { recipient_id: b.uid, items: items(env, [a.pc]), recipient_wikibidous: 50 }), Trade)
        assert.deepEqual([one.items.map((i) => i.user_card_id), one.initiator_wikibidous, one.recipient_wikibidous], [[a.pc], 0, 50])
      },
    },
    {
      name: 'pas amis → 403 FORBIDDEN ; copie d\'un autre → 403 42501',
      run: async (env) => {
        const [a, b] = pair(env)
        const stranger = player(env)
        await refused(await create(env, a.uid, { recipient_id: stranger.uid, items: items(env, [a.c]) }), 403,
          'Vous devez être amis pour échanger', 'FORBIDDEN')
        const theirs = items(env, [b.pc]).map((i) => ({ ...i, offered_by: a.uid }))
        await refused(await create(env, a.uid, { recipient_id: b.uid, items: theirs }), 403, 'Vous ne possédez pas cette carte', '42501')
      },
    },
    {
      name: 'items: [] → 400 ; 101 éléments d\'un côté → 400 « Au plus 100 cartes par côté » (SQL) ; 10 001 WB ou −1 WB → 400 ; soi-même → 400 ; solde trop bas → 409 ; {} → 400',
      run: async (env) => {
        const [a, b] = pair(env)
        const post = (body: object) => create(env, a.uid, { recipient_id: b.uid, ...body })
        const unit = items(env, [a.c])
        await refused(await post({ items: [] }), 400, 'Un échange contient au moins une carte', 'invalid_request')
        // La même copie 101 fois, exprès : le plafond par côté est vérifié avant la possession.
        await refused(await post({ items: Array(101).fill(unit[0]) }), 400, 'Au plus 100 cartes par côté', 'invalid_request')
        await refused(await post({ items: unit, recipient_wikibidous: 10001 }), 400, 'Entre 0 et 10 000 wikibidous par côté', 'invalid_request')
        // z.int32() laisse passer −1 : le 400 vient du SQL.
        await refused(await post({ items: unit, initiator_wikibidous: -1 }), 400, 'Entre 0 et 10 000 wikibidous par côté', 'invalid_request')
        await refused(await post({ items: unit, recipient_id: a.uid }), 400, 'Tu ne peux pas échanger avec toi-même', 'invalid_request')
        await refused(await post({ items: unit, initiator_wikibidous: 1001 }), 409, 'Solde insuffisant', 'insufficient_balance')
        await failed(await create(env, a.uid, {}), 400, 'invalid_request')
      },
    },
    {
      name: 'contre-offre du destinataire → 200 avec parent_trade_id ; le GET du parent rend countered et counter_trade_id',
      run: async (env) => {
        const [a, b] = pair(env)
        const parent = proposed(env, a, b)
        const counter = await ok(await create(env, b.uid, { recipient_id: a.uid, items: items(env, [b.c]), parent_trade_id: parent }), Trade)
        assert.equal(counter.parent_trade_id, parent)
        const { trade } = await ok(await api(env, at(parent), { uid: a.uid }), One)
        assert.deepEqual([trade.status, trade.counter_trade_id], ['countered', counter.id])
      },
    },
    {
      name: 'même Idempotency-Key deux fois → corps identiques, un seul échange',
      run: async (env) => {
        const [a, b] = pair(env)
        const key = idem()
        const body = { recipient_id: b.uid, items: items(env, [a.c]) }
        const first = await ok(await create(env, a.uid, body, key), Trade)
        assert.deepEqual(await ok(await create(env, a.uid, body, key), Trade), first)
        assert.equal(sql(env, `select count(*) from public.trades where initiator_id = :'uid'`, { uid: a.uid }), '1')
      },
    },
  ],
}

export const tradeAction: RouteSpec = {
  method: 'PATCH',
  path: '/api/trades/{tradeId}',
  source: 'R§3.6',
  confidence: 'conf.',
  cases: [
    noSession('PATCH', at(randomUUID())),
    {
      name: 'tradeId=abc → 400 invalid_request',
      run: async (env) => void (await failed(await act(env, makeUser(db(env)).uid, 'abc', 'accept'), 400, 'invalid_request')),
    },
    {
      name: 'accept → { status: accepted, trade } ; copie reçue sous son id, WB nets ; même clé → corps identique ; sans clé → 409 (M4-8)',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b, { iwb: 30, rwb: 100 })
        const key = idem()
        const done = await ok(await act(env, b.uid, id, 'accept', key), Acted)
        assert.deepEqual([done.status, done.trade.id, done.trade.status], ['accepted', id, 'accepted'])
        assert.deepEqual((await copies(env, b.uid)).toSorted(), [a.c, b.c].toSorted())
        assert.deepEqual([await balance(env, a.uid), await balance(env, b.uid)], [1070, 930])
        assert.deepEqual(await ok(await act(env, b.uid, id, 'accept', key), Acted), done)
        await refused(await act(env, b.uid, id, 'accept'), 409, DONE)
      },
    },
    {
      name: 'decline par l\'initiateur, cancel par le destinataire → 403 FORBIDDEN',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b)
        await refused(await act(env, a.uid, id, 'decline'), 403, 'Seul le destinataire peut refuser cet échange', 'FORBIDDEN')
        await refused(await act(env, b.uid, id, 'cancel'), 403, 'Seul l\'initiateur peut annuler cet échange', 'FORBIDDEN')
      },
    },
    {
      name: 'decline → declined, cancel → cancelled ; même Idempotency-Key deux fois → corps identiques',
      run: async (env) => {
        const [a, b] = pair(env)
        for (const [uid, action, status] of [[b.uid, 'decline', 'declined'], [a.uid, 'cancel', 'cancelled']]) {
          const id = proposed(env, a, b)
          const key = idem()
          const first = await ok(await act(env, uid, id, action, key), Acted)
          assert.deepEqual([first.status, first.trade.status], [status, status])
          assert.deepEqual(await ok(await act(env, uid, id, action, key), Acted), first)
        }
      },
    },
    {
      name: 'inconnu, ou existant mais d\'un autre → 404 « Échange introuvable » ; { action: counter } → 400 « Action inconnue » (P11) ; expires_at passé → 409',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b)
        await refused(await act(env, b.uid, randomUUID(), 'accept'), 404, 'Échange introuvable')
        await refused(await act(env, makeUser(db(env)).uid, id, 'accept'), 404, 'Échange introuvable')
        await refused(await act(env, b.uid, id, 'counter'), 400, 'Action inconnue', 'invalid_request')
        sql(env, `update public.trades set expires_at = now() - interval '1 minute' where id = :'id'`, { id })
        await refused(await act(env, b.uid, id, 'accept'), 409, DONE)
      },
    },
    {
      name: 'erreur injectée sur la notification (M4-7 B) → 500, état complet inchangé ; la même clé sans le trigger → 200 accepted',
      run: async (env) => {
        const [a, b] = pair(env)
        const id = proposed(env, a, b, { iwb: 30, rwb: 100 })
        // Étoile, étiquette et avatar sur les copies échangées : l'acceptation les effacerait.
        sql(env, `update public.user_cards set starred = true where id in (:'c', :'pc');
with t as (insert into public.tags (user_id, name) values (:'a', 'gardée') returning id) insert into public.user_card_tags (user_card_id, tag_id) select :'c', id from t;
update public.profiles set avatar_user_card_id = :'pc' where id = :'b'`, { a: a.uid, b: b.uid, c: a.c, pc: b.pc })
        const s0 = snap(env, id)
        const t = `contract_boom_${id.slice(0, 8)}`
        const key = idem()
        try {
          sql(env, `create trigger :"t" after insert on public.notifications for each row when (new.data ->> 'trade_id' = :'id')
execute function tests.boom()`, { t, id })
          await refused(await act(env, b.uid, id, 'accept', key), 500, INTERNAL)
          // check_invariants y est global : égalité sûre parce que le contrat tourne en séquence (un seul fichier, contract/run.test.ts).
          assert.deepEqual(snap(env, id), s0)
        } finally {
          sql(env, `drop trigger if exists :"t" on public.notifications`, { t })
        }
        assert.equal((await ok(await act(env, b.uid, id, 'accept', key), Acted)).status, 'accepted')
      },
    },
  ],
}

export const trades: RouteSpec[] = [tradesList, tradeDetail, tradeCreate, tradeAction]
