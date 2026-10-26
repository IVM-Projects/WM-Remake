import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { forbiddenKeys, idCounts } from '../leak.ts'
import { api, created, failed, giveCards, idem, Iso, makeUser, noSession, ok, psql, refused, send } from '../users.ts'
import { befriend } from './friends.ts'

// Objet Battle de wm.battle_json (C5, C6, R:274, R:276) : colonnes de public.battles, ses deux joueurs, ses échéances et l'état de partie.
const Who = z.object({ id: z.uuid(), username: z.string() }).loose()
const Player = z.object({ cardIds: z.array(z.uuid()).length(3), usedCardIds: z.array(z.uuid()), currentHp: z.int().min(0),
  maxHp: z.int().min(0) }).loose()
const Turn = z.object({ turnNumber: z.int(), attackerUserId: z.uuid(), defenderId: z.uuid(), attackCardId: z.uuid(), allCorrect: z.boolean(),
  damageDealt: z.int().min(0), wrong: z.int(), total: z.int() }).loose()
// Strict : une clé en plus d'une question ou d'une option (correct, q_index…) la fait échouer (C23).
const Question = z.strictObject({ id: z.uuid(), prompt: z.string(),
  options: z.array(z.strictObject({ id: z.uuid(), text: z.string() })).length(4) })
const PendingAttack = z.object({ attackerUserId: z.uuid(), defenderId: z.uuid(), attackCardId: z.uuid(), attackCardName: z.string(),
  questions: z.array(Question).length(3), answered: z.array(z.uuid()) }).loose()
const GameState = z.object({ players: z.record(z.uuid(), Player), turnHistory: z.array(Turn), phase: z.enum(['attack', 'quiz', 'over']).optional(),
  currentTurnUserId: z.uuid().optional(), turnNumber: z.int().optional(), pendingAttack: PendingAttack.nullable().optional(),
  winnerId: z.uuid().optional() }).loose()
const Battle = z.object({
  id: z.uuid(), challenger_id: z.uuid(), opponent_id: z.uuid(), winner_id: z.uuid().nullable(),
  status: z.enum(['pending', 'deck_selection', 'generating_quizzes', 'active', 'completed', 'cancelled']),
  created_at: Iso, updated_at: Iso, challenger: Who, opponent: Who, expires_at: Iso.nullable(), idle_at: Iso.nullable(),
  game_state: GameState.nullable().optional(),
}).loose()
// Enveloppes strictes (comme trades.ts) : une clé en plus au premier niveau fait échouer le cas.
const Quota = z.strictObject({ used: z.int().min(0), limit: z.int().min(1), resets_at: Iso })
const List = z.strictObject({ battles: z.array(Battle), challenge_quota: Quota, rules: z.record(z.string(), z.int()) })
const Detail = z.strictObject({ battle: Battle, decks: z.array(z.strictObject({ user_id: z.uuid(), card_ids: z.array(z.uuid()).length(3) })),
  reward: z.int().nullable() })
const Answer = Detail.extend({ correct: z.boolean(), correct_answer_id: z.uuid(), last_turn: z.boolean(), status: Battle.shape.status })
const Created = z.strictObject({ battle: z.strictObject({ id: z.uuid() }), id: z.uuid() })
const NOT_FOUND = 'Bataille introuvable'
const NO_QUESTION = 'Aucune question ne t\'attend'

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const at = (id: string) => `/api/battles/${id}`
const post = (env: ContractEnv, uid: string, body: unknown, headers?: Record<string, string>) => send(env, 'POST', '/api/battles', uid, body, headers)
const act = (env: ContractEnv, uid: string, id: string, body: unknown, headers?: Record<string, string>) => send(env, 'PATCH', at(id), uid, body, headers)

type Duelist = { uid: string; username: string; cards: string[] }
function friends(env: ContractEnv): [Duelist, Duelist] {
  const [a, b] = [makeUser(db(env)), makeUser(db(env))]
  befriend(env, a.uid, b.uid)
  return [{ ...a, cards: [] }, { ...b, cards: [] }]
}
// Deux amis à 3 copies C chacun (les 3 mêmes cartes du seed).
function duel(env: ContractEnv): [Duelist, Duelist] {
  return friends(env).map((p) => ({ ...p, cards: giveCards(db(env), p.uid, 'C', 3) })) as [Duelist, Duelist]
}
// Défi de a à b par wm.battle_create, accepté par b si `accepted` ; renvoie son id.
function challenged(env: ContractEnv, a: string, b: string, accepted = false): string {
  const id = sql(env, `select wm.battle_create(:'a', :'b') ->> 'id'`, { a, b })
  if (accepted) sql(env, `select wm.battle_action(:'b', :'id', 'accept')`, { b, id })
  return id
}
// answerId juste, ou une autre option de la question : le secret est lu par psql (fixture de test, jamais l'app).
const answer = (env: ContractEnv, battleId: string, questionId: string, right: boolean) => sql(env, `select case when :'right'::boolean
  then s.correct_option_id else (select o ->> 'id' from public.battles b, jsonb_array_elements(b.game_state #> '{pendingAttack,questions}') q,
    jsonb_array_elements(q -> 'options') o where b.id = s.battle_id and q ->> 'id' = :'q' and o ->> 'id' <> s.correct_option_id limit 1) end
from wm.battle_secrets s where s.battle_id = :'id' and s.question_id = :'q'`, { id: battleId, q: questionId, right: String(right) })

export const battlesList: RouteSpec = {
  method: 'GET',
  path: '/api/battles',
  source: 'R§3.9',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/battles'),
    {
      name: 'un défi en attente → { battles, challenge_quota, rules } (game_state nul, limit 3, rules = la config battle) ; '
        + 'x-wiki-calendar-tz Pacific/Kiritimati → resets_at au prochain minuit de Kiritimati',
      run: async (env) => {
        const [a, b] = friends(env)
        const id = challenged(env, a.uid, b.uid)
        const list = await ok(await api(env, '/api/battles', { uid: a.uid }), List)
        assert.deepEqual(list.battles.map((x) => [x.id, x.status, x.game_state, x.challenger.id, x.opponent.username]),
          [[id, 'pending', null, a.uid, b.username]])
        assert.deepEqual([list.challenge_quota.used, list.challenge_quota.limit], [1, 3])
        assert.deepEqual(list.rules, JSON.parse(sql(env, `select value from wm.config where key = 'battle'`)))
        const kiri = await ok(await api(env, '/api/battles', { uid: a.uid, headers: { 'x-wiki-calendar-tz': 'Pacific/Kiritimati' } }), List)
        const midnight = sql(env, `select extract(epoch from (date_trunc('day', now() at time zone 'Pacific/Kiritimati') + interval '1 day')
  at time zone 'Pacific/Kiritimati')`)
        assert.equal(Date.parse(kiri.challenge_quota.resets_at), Number(midnight) * 1000)
      },
    },
  ],
}

export const battleCreate: RouteSpec = {
  method: 'POST',
  path: '/api/battles',
  source: 'R§3.9',
  confidence: 'prob.',
  cases: [
    noSession('POST', '/api/battles'),
    {
      name: 'un ami → 201 { battle: { id }, id } aux ids égaux ; soi → 400 ; non-ami → 403 ; joueur inconnu → 404 ; opponent_id: x → 400 ; '
        + 'bataille ouverte avec ce joueur → 409 { error, message, battle_id }',
      run: async (env) => {
        const [a, b] = friends(env)
        const one = await created(await post(env, a.uid, { opponent_id: b.uid }), Created)
        assert.equal(one.battle.id, one.id)
        assert.equal(sql(env, `select challenger_id || ' ' || opponent_id || ' ' || status from public.battles where id = :'id'`, { id: one.id }),
          `${a.uid} ${b.uid} pending`)
        await refused(await post(env, a.uid, { opponent_id: a.uid }), 400, 'Tu ne peux pas te défier toi-même', 'invalid_request')
        await refused(await post(env, a.uid, { opponent_id: makeUser(db(env)).uid }), 403, 'Vous devez être amis pour vous défier', 'FORBIDDEN')
        await refused(await post(env, a.uid, { opponent_id: randomUUID() }), 404, 'Joueur introuvable')
        await refused(await post(env, a.uid, { opponent_id: 'x' }), 400, 'UUID invalide', 'invalid_request')
        const busy = 'Une bataille est déjà en cours avec ce joueur'
        assert.deepEqual(await failed(await post(env, a.uid, { opponent_id: b.uid }), 409), { error: busy, message: busy, battle_id: one.id })
      },
    },
    {
      name: 'même Idempotency-Key deux fois → corps identiques, une seule bataille',
      run: async (env) => {
        const [a, b] = friends(env)
        const key = idem()
        const first = await created(await post(env, a.uid, { opponent_id: b.uid }, key), Created)
        assert.deepEqual(await created(await post(env, a.uid, { opponent_id: b.uid }, key), Created), first)
        assert.equal(sql(env, `select count(*) from public.battles where challenger_id = :'uid'`, { uid: a.uid }), '1')
      },
    },
    {
      name: 'Review Focus, quota par HTTP : quota_free à 1 (psql) → le 2ᵉ défi 429 sans code, retry_after ISO (= resets_at), '
        + 'challenge_quota { used: 1, limit: 1, resets_at }, Retry-After entier de 1 à 86 400',
      run: async (env) => {
        const [a, b] = friends(env)
        const c = makeUser(db(env))
        befriend(env, a.uid, c.uid)
        // Fuseau sans changement d'heure : un jour de 25 h (Europe/Paris en octobre) porterait Retry-After au-delà de 86 400.
        const tz = { 'x-wiki-calendar-tz': 'Etc/GMT-14' }
        const battle = sql(env, `select value from wm.config where key = 'battle'`)
        sql(env, `update wm.config set value = jsonb_set(value, '{quota_free}', '1') where key = 'battle'`)
        try {
          await created(await post(env, a.uid, { opponent_id: b.uid }, tz), Created)
          const res = await post(env, a.uid, { opponent_id: c.uid }, tz)
          const body = await failed(res, 429)
          const quota = Quota.parse(body.challenge_quota)
          const full = 'Limite quotidienne de défis atteinte'
          assert.deepEqual(body, { error: full, message: full, retry_after: Iso.parse(body.retry_after),
            challenge_quota: { used: 1, limit: 1, resets_at: quota.resets_at } })
          assert.equal(Date.parse(String(body.retry_after)), Date.parse(quota.resets_at))
          const after = res.headers.get('retry-after') ?? ''
          assert.match(after, /^[1-9][0-9]*$/)
          assert.ok(Number(after) <= 86_400, `Retry-After: ${after}`)
          assert.equal(sql(env, `select count(*) from public.battles where challenger_id = :'uid'`, { uid: a.uid }), '1')
        } finally {
          // Sans assertion : un échec ici masquerait celui du cas.
          sql(env, `update wm.config set value = :'battle' where key = 'battle'`, { battle })
        }
      },
    },
  ],
}

export const battleDetail: RouteSpec = {
  method: 'GET',
  path: '/api/battles/{battleId}',
  source: 'R§3.9',
  confidence: 'prob.',
  cases: [
    noSession('GET', at(randomUUID())),
    {
      name: 'battleId=abc → 400 invalid_request',
      run: async (env) => void (await refused(await api(env, at('abc'), { uid: makeUser(db(env)).uid }), 400, 'UUID invalide', 'invalid_request')),
    },
    {
      name: 'un tiers → 404 « Bataille introuvable » ; choix des cartes après le deck de A : B ne voit ni ses joueurs ni ses decks, A le sien',
      run: async (env) => {
        const [a, b] = duel(env)
        const id = challenged(env, a.uid, b.uid, true)
        sql(env, `select wm.battle_action(:'a', :'id', 'submit_deck', jsonb_build_object('card_ids', string_to_array(:'cards', ',')))`,
          { a: a.uid, id, cards: a.cards.join(',') })
        await refused(await api(env, at(id), { uid: makeUser(db(env)).uid }), 404, NOT_FOUND)
        const seen = await ok(await api(env, at(id), { uid: b.uid }), Detail)
        assert.deepEqual([seen.battle.status, seen.battle.game_state?.players, seen.decks, seen.reward], ['deck_selection', {}, [], null])
        const mine = await ok(await api(env, at(id), { uid: a.uid }), Detail)
        const players = mine.battle.game_state?.players ?? {}
        assert.deepEqual([Object.keys(players), mine.decks], [[a.uid], [{ user_id: a.uid, card_ids: players[a.uid]?.cardIds }]])
      },
    },
  ],
}

export const battleAction: RouteSpec = {
  method: 'PATCH',
  path: '/api/battles/{battleId}',
  source: 'R§3.9',
  confidence: 'prob.',
  cases: [
    noSession('PATCH', at(randomUUID())),
    {
      name: '{ action: dance } → 400 « Action inconnue » (P11) ; submit_deck d\'une copie de l\'autre → 403 42501, aucun deck',
      run: async (env) => {
        const [a, b] = duel(env)
        const id = challenged(env, a.uid, b.uid, true)
        await refused(await act(env, a.uid, id, { action: 'dance' }), 400, 'Action inconnue', 'invalid_request')
        await refused(await act(env, a.uid, id, { action: 'submit_deck', card_ids: [b.cards[0], a.cards[1], a.cards[2]] }), 403,
          'Vous ne possédez pas cette carte', '42501')
        assert.equal(sql(env, `select count(*) from public.battle_decks where battle_id = :'id'`, { id }), '0')
      },
    },
    {
      name: 'accept : même Idempotency-Key deux fois → corps identiques, en choix des cartes',
      run: async (env) => {
        const [a, b] = friends(env)
        const id = challenged(env, a.uid, b.uid)
        const key = idem()
        const first = await ok(await act(env, b.uid, id, { action: 'accept' }, key), Detail)
        assert.equal(first.battle.status, 'deck_selection')
        assert.deepEqual(await ok(await act(env, b.uid, id, { action: 'accept' }, key), Detail), first)
      },
    },
    {
      name: 'Review Focus, bataille entière par HTTP (défi, acceptation, deux decks, six attaques, dix-huit réponses, B juste et A faux, '
        + 'liste et détail des deux après chaque écriture) : aucun corps ne distingue la bonne option (C23) ni n\'a de clé interdite, '
        + 'options triées, double clic, attaque rejouée, fin à 50 et 10 WB, invariants',
      timeout: 60_000,
      run: async (env) => {
        const [a, b] = duel(env)
        // Chaque corps gardé avec sa requête, erreurs comprises ; `answered` : la question d'une réponse 200 à submit_single_answer.
        const kept: Array<{ req: string; text: string; answered?: string }> = []
        const call = async (uid: string, method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>) => {
          const res = await send(env, method, path, uid, body, headers)
          const text = await res.text()
          const answered = body?.action === 'submit_single_answer' && res.status === 200 ? String(body.questionId) : undefined
          kept.push({ req: `${uid === a.uid ? 'A' : 'B'} ${method} ${path} ${JSON.stringify(body ?? null)} → ${res.status}`, text, answered })
          return new Response(text, { status: res.status, headers: res.headers })
        }
        let id = ''
        const look = async () => {
          for (const { uid } of [a, b]) {
            await ok(await call(uid, 'GET', '/api/battles'), List)
            await ok(await call(uid, 'GET', at(id)), Detail)
          }
        }
        const write = async <T>(p: Duelist, schema: z.ZodType<T>, body: Record<string, unknown>, headers?: Record<string, string>) => {
          const out = await ok(await call(p.uid, 'PATCH', at(id), body, headers), schema)
          await look()
          return out
        }

        id = (await created(await call(a.uid, 'POST', '/api/battles', { opponent_id: b.uid }), Created)).id
        await look()
        await write(b, Detail, { action: 'accept' })
        await write(a, Detail, { action: 'submit_deck', card_ids: a.cards })
        assert.equal((await write(b, Detail, { action: 'submit_deck', card_ids: b.cards })).battle.status, 'active')
        for (let turn = 1; turn <= 6; turn++) {
          const [att, def] = turn % 2 ? [a, b] : [b, a]
          const attack = { action: 'submit_attack', attack_card_id: att.cards[(turn - 1) >> 1] }
          const key = idem()
          const attacked = await write(att, Detail, attack, key)
          const pa = PendingAttack.parse(attacked.battle.game_state?.pendingAttack)
          assert.deepEqual([pa.attackerUserId, pa.defenderId, pa.answered], [att.uid, def.uid, []])
          for (const [i, q] of pa.questions.entries()) {
            const reply = { action: 'submit_single_answer', questionId: q.id, answerId: answer(env, id, q.id, def === b) }
            if (turn > 1 || i > 0) {
              const res = await write(def, Answer, reply)
              assert.deepEqual([res.correct, res.last_turn, res.status], [def === b, i === 2, turn === 6 && i === 2 ? 'completed' : 'active'])
              continue
            }
            // Refus gardés aussi : réponse de l'attaquant, option inconnue.
            await refused(await call(att.uid, 'PATCH', at(id), reply), 409, NO_QUESTION)
            await refused(await call(def.uid, 'PATCH', at(id), { ...reply, answerId: randomUUID() }), 400, 'Réponse inconnue', 'invalid_request')
            // Review Focus, double clic : sans clé avec l'autre option → le résultat enregistré ; même clé → le même corps.
            const qKey = idem()
            const first = await write(def, Answer, reply, qKey)
            const other = q.options.find((o) => o.id !== reply.answerId)?.id
            const again = await write(def, Answer, { ...reply, answerId: other })
            assert.deepEqual([again.correct, again.correct_answer_id, again.battle.game_state?.pendingAttack?.answered],
              [first.correct, first.correct_answer_id, [q.id]])
            assert.deepEqual(await write(def, Answer, reply, qKey), first)
            assert.deepEqual(JSON.parse(sql(env, `select json_agg(answer_id) filter (where answered_at is not null) from wm.battle_secrets
where battle_id = :'id'`, { id })), [reply.answerId])
          }
          // La réponse stockée de l'attaque, rejouée par sa clé, une fois le tour fini.
          if (turn === 1) assert.deepEqual(await ok(await call(att.uid, 'PATCH', at(id), attack, key), Detail), attacked)
        }
        for (const [p, reward] of [[a, 10], [b, 50]] as const) {
          const { battle, reward: got } = await ok(await call(p.uid, 'GET', at(id)), Detail)
          assert.deepEqual([battle.status, battle.winner_id, battle.game_state?.winnerId, got], ['completed', b.uid, b.uid, reward])
        }
        assert.equal(sql(env, `select string_agg(coalesce(s.battles_won, 0)::text, ' ' order by u.o) from unnest(array[:'a', :'b']::uuid[])
  with ordinality u (id, o) left join wm.user_stats s on s.user_id = u.id`, { a: a.uid, b: b.uid }), '0 1')
        // Global : sûr parce que le contrat tourne en séquence (contract/spec/trades.ts).
        assert.equal(sql(env, `select wm.check_invariants()`), '[]')

        // C23 : les 18 questions et leurs 4 options, prises dans les pendingAttack gardés (options triées par id, C7).
        const options = new Map<string, string[]>()
        for (const { text } of kept) {
          const body = JSON.parse(text) as { battle?: z.infer<typeof Battle>; battles?: Array<z.infer<typeof Battle>> }
          for (const x of [body.battle, ...(body.battles ?? [])]) {
            if (x?.game_state?.pendingAttack == null) continue
            for (const q of PendingAttack.parse(x.game_state.pendingAttack).questions) {
              const ids = q.options.map((o) => o.id)
              assert.deepEqual(ids, [...ids].sort(), `options de ${q.id}`)
              options.set(q.id, ids)
            }
          }
        }
        const secrets = new Map(JSON.parse(sql(env, `select json_agg(json_build_array(question_id, correct_option_id)) from wm.battle_secrets
where battle_id = :'id'`, { id })) as Array<[string, string]>)
        assert.deepEqual([options.size, [...secrets.keys()].sort()], [18, [...options.keys()].sort()])
        for (const [q, ids] of options) {
          const right = secrets.get(q) ?? ''
          assert.ok(ids.includes(right), q)
          for (const k of kept) {
            const [n, ...rest] = idCounts(k.text, [right, ...ids.filter((o) => o !== right)])
            assert.deepEqual([n, ...rest], [rest[0] + (k.answered === q ? 1 : 0), rest[0], rest[0], rest[0]], `${k.req} : question ${q}`)
          }
        }
        for (const k of kept) assert.deepEqual(forbiddenKeys(JSON.parse(k.text), k.answered !== undefined), [], k.req)
      },
    },
  ],
}

export const battles: RouteSpec[] = [battlesList, battleCreate, battleDetail, battleAction]
