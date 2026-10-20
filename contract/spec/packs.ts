import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, makeUser, psql } from '../users.ts'

const RARITIES = ['C', 'PC', 'R', 'SR', 'UR', 'L'] as const
const Rarity = z.enum(RARITIES)
const Iso = z.iso.datetime({ offset: true })

// Union des variantes du R§3.1 : toutes les clés présentes (les nullables aussi).
const CardInPack = z.object({
  id: z.uuid(),
  card_id: z.uuid(),
  user_card_id: z.uuid(),
  card: z.object({ id: z.uuid(), wikipedia_title: z.string(), rarity: Rarity, is_shiny: z.boolean() }),
  wikipedia_title: z.string(),
  rarity: Rarity,
  snapshot_rarity: Rarity,
  is_shiny: z.boolean(),
  image_url: z.string().nullable(),
  wikipedia_url: z.string(),
  category: z.string().nullable(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  atk: z.int(),
  def: z.int(),
  hide_image: z.boolean(),
  nsfw_image: z.boolean(),
  is_new: z.boolean(),
})
const Cards = z.object({ cards: z.array(CardInPack) })
const Opened = Cards.extend({
  packs_remaining: z.int(),
  packs_last_regen_at: Iso.nullable(),
  next_regen_at: Iso.nullable(),
  owned_copies: z.array(z.object({ card_id: z.uuid(), is_shiny: z.boolean(), count: z.int() })),
})
const HUMAN_FAILED = 'Vérification anti-bot échouée, réessaie.'

// Corps D§8.2 : error = message, code exact (absent si non donné) ; renvoie le corps pour ses clés en plus.
async function failed(res: Response, status: number, code?: string): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(res.status, status, JSON.stringify(body))
  assert.equal(typeof body.error, 'string')
  assert.equal(body.message, body.error)
  assert.equal(body.code, code)
  return body
}

async function ok<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return schema.parse(body)
}

const sql = (env: ContractEnv, query: string, uid: string) => psql(env.backend.databaseUrl, query, { uid })
const post = (env: ContractEnv, path: string, uid?: string, body?: unknown, headers?: Record<string, string>) =>
  api(env, path, { method: 'POST', uid, body, headers })

export const packsOpen: RouteSpec = {
  method: 'POST',
  path: '/api/packs/open',
  source: 'R§3.1',
  confidence: 'conf.',
  cases: [
    {
      name: 'sans session → 401 unauthorized (D§8.2)',
      run: async (env) => void (await failed(await post(env, '/api/packs/open'), 401, 'unauthorized')),
    },
    {
      name: 'nouveau joueur → 403 human_verification_required ; human-check dev-bypass → 200 { ok: true } ; puis 200 et 5 cartes',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const denied = await failed(await post(env, '/api/packs/open', uid), 403, 'human_verification_required')
        assert.equal(denied.error, 'Vérification anti-bot requise pour continuer à ouvrir des paquets.')
        assert.equal(denied.human_verification_required, true)
        const check = await post(env, '/api/human-check', uid, { token: 'dev-bypass' })
        assert.equal(check.status, 200)
        assert.deepEqual(await check.json(), { ok: true })
        assert.equal((await ok(await post(env, '/api/packs/open', uid), Opened)).cards.length, 5)
      },
    },
    {
      name: 'corps { count: 1 } ignoré → cartes à toutes les clés de l\'union, triées par rareté croissante, owned_copies tableau',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        const { cards, packs_remaining } = await ok(await post(env, '/api/packs/open', uid, { count: 1 }), Opened)
        assert.equal(cards.length, 5)
        assert.equal(packs_remaining, 0)
        for (const c of cards) assert.ok(c.id === c.card_id && c.card.id === c.id && c.rarity === c.snapshot_rarity, JSON.stringify(c))
        const ranks = cards.map((c) => RARITIES.indexOf(c.snapshot_rarity))
        assert.deepEqual(ranks, ranks.toSorted((a, b) => a - b))
      },
    },
    {
      name: 'stock vide → 403 « Plus de paquets disponibles », packs_remaining 0 et next_regen_at ISO',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        sql(env, `update public.profiles set packs_remaining = 0, packs_last_regen_at = now() where id = :'uid'`, uid)
        const body = await failed(await post(env, '/api/packs/open', uid), 403)
        assert.equal(body.error, 'Plus de paquets disponibles')
        assert.equal(body.packs_remaining, 0)
        Iso.parse(body.next_regen_at)
      },
    },
    {
      name: 'deuxième ouverture immédiate → 429 « Le site demande de ralentir », rate_limited, retry_after ISO, Retry-After ≥ 1',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        sql(env, `update public.profiles set packs_remaining = 3 where id = :'uid'`, uid)
        await ok(await post(env, '/api/packs/open', uid), Opened)
        // Dernière ouverture dans 30 s : le 429 ne dépend plus de la vitesse du banc.
        sql(env, `update wm.user_state set last_open_at = now() + interval '30 seconds' where user_id = :'uid'`, uid)
        const res = await post(env, '/api/packs/open', uid)
        const body = await failed(res, 429)
        assert.equal(body.error, 'Le site demande de ralentir')
        assert.equal(body.rate_limited, true)
        Iso.parse(body.retry_after)
        assert.ok(Number(res.headers.get('retry-after')) >= 1, `Retry-After: ${res.headers.get('retry-after')}`)
      },
    },
    {
      name: 'Idempotency-Key rejouée → même corps, une seule série de 5 copies en base',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        sql(env, `update public.profiles set packs_remaining = 3 where id = :'uid'`, uid)
        const key = { 'Idempotency-Key': randomUUID() }
        const first = await ok(await post(env, '/api/packs/open', uid, undefined, key), Opened)
        const again = await ok(await post(env, '/api/packs/open', uid, undefined, key), Opened)
        assert.deepEqual(again, first)
        assert.equal(sql(env, `select count(*) from public.user_cards where user_id = :'uid'`, uid), '5')
      },
    },
    {
      name: 'x-wiki-calendar-tz: ../../etc/passwd + plafond du jour de Paris atteint → 429 rate_limit_daily, retry_after = minuit de Paris',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        // Plafond atteint au jour de Paris ; attendu calculé par PG : prochain minuit de Paris, en secondes epoch.
        const midnight = sql(env, `update wm.user_state set opens_day = (now() at time zone 'Europe/Paris')::date,
  opens_day_count = (select value::int from wm.config where key = 'open_daily_cap'), last_open_at = now() - interval '1 hour'
where user_id = :'uid';
select extract(epoch from ((now() at time zone 'Europe/Paris')::date + 1)::timestamp at time zone 'Europe/Paris')`, uid)
        const body = await failed(await post(env, '/api/packs/open', uid, undefined, { 'x-wiki-calendar-tz': '../../etc/passwd' }), 429)
        assert.equal(body.error, 'Limite quotidienne de paquets atteinte')
        assert.equal(body.rate_limit_daily, true)
        assert.equal(Date.parse(Iso.parse(body.retry_after)), Number(midnight) * 1000)
      },
    },
  ],
}

export const humanCheck: RouteSpec = {
  method: 'POST',
  path: '/api/human-check',
  source: 'R§3.1',
  confidence: 'conf.',
  cases: [
    {
      name: '{ token: "mauvais" } → 400 { ok: false, code: human_check_failed }, vérification non posée',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const res = await post(env, '/api/human-check', uid, { token: 'mauvais' })
        assert.equal(res.status, 400)
        assert.deepEqual(await res.json(), { ok: false, code: 'human_check_failed', error: HUMAN_FAILED, message: HUMAN_FAILED })
        assert.equal(sql(env, `select human_verified_until is null from wm.user_state where user_id = :'uid'`, uid), 't')
      },
    },
    {
      name: '{} → 400 invalid_request',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        await failed(await post(env, '/api/human-check', uid, {}), 400, 'invalid_request')
      },
    },
  ],
}

const ProStatus = z.object({ eligible: z.boolean(), claimed_today: z.boolean(), size: z.literal(15), next_claim_at: Iso.nullable() })

export const proDailyStatus: RouteSpec = {
  method: 'GET',
  path: '/api/packs/pro-daily',
  source: 'R§3.1',
  confidence: 'prob.',
  cases: [
    {
      name: 'non-Pro → { eligible: false, claimed_today: false, size: 15 } ; Pro → eligible: true',
      run: async (env) => {
        const free = makeUser(env.backend.databaseUrl)
        const pro = makeUser(env.backend.databaseUrl, { pro: true })
        assert.deepEqual(await ok(await api(env, '/api/packs/pro-daily', { uid: free.uid }), ProStatus),
          { eligible: false, claimed_today: false, size: 15, next_claim_at: null })
        assert.equal((await ok(await api(env, '/api/packs/pro-daily', { uid: pro.uid }), ProStatus)).eligible, true)
      },
    },
  ],
}

export const proDailyClaim: RouteSpec = {
  method: 'POST',
  path: '/api/packs/pro-daily',
  source: 'R§3.1',
  confidence: 'prob.',
  cases: [
    {
      name: 'non-Pro vérifié → 403 pro_required',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        await failed(await post(env, '/api/packs/pro-daily', uid), 403, 'pro_required')
      },
    },
    {
      name: 'Pro vérifié → 15 cartes sans C ; seconde réclamation → 409 already_claimed ; statut claimed_today',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { pro: true, humanVerified: true })
        const tz = { 'x-wiki-calendar-tz': 'Europe/Paris' }
        const { cards } = await ok(await post(env, '/api/packs/pro-daily', uid, undefined, tz), Cards)
        assert.equal(cards.length, 15)
        assert.ok(cards.every((c) => c.snapshot_rarity !== 'C'), JSON.stringify(cards.map((c) => c.snapshot_rarity)))
        Iso.parse((await failed(await post(env, '/api/packs/pro-daily', uid, undefined, tz), 409, 'already_claimed')).next_claim_at)
        const status = await ok(await api(env, '/api/packs/pro-daily', { uid, headers: tz }), ProStatus)
        assert.deepEqual([status.eligible, status.claimed_today], [false, true])
      },
    },
  ],
}

export const specialList: RouteSpec = {
  method: 'GET',
  path: '/api/packs/special',
  source: 'R§3.1',
  confidence: 'prob.',
  cases: [
    {
      name: 'aucun paquet actif → { packs: [], available: false }',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const res = await api(env, '/api/packs/special', { uid })
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), { packs: [], available: false })
      },
    },
  ],
}

export const specialClaim: RouteSpec = {
  method: 'POST',
  path: '/api/packs/special',
  source: 'R§3.1',
  confidence: 'prob.',
  cases: [
    {
      name: 'packId inconnu → 404 « Paquet introuvable »',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        const body = await failed(await post(env, '/api/packs/special', uid, { packId: randomUUID() }), 404)
        assert.equal(body.error, 'Paquet introuvable')
      },
    },
    {
      name: 'packId: "x" → 400 invalid_request',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        await failed(await post(env, '/api/packs/special', uid, { packId: 'x' }), 400, 'invalid_request')
      },
    },
  ],
}

export const grace: RouteSpec = {
  method: 'POST',
  path: '/api/packs/grace',
  source: 'R§3.1',
  confidence: 'inc.',
  cases: [
    {
      name: 'sans dotation → 404 no_grace',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        await failed(await post(env, '/api/packs/grace', uid), 404, 'no_grace')
      },
    },
    {
      name: 'dotation de 3 insérée par psql → 200 { cards } (3 cartes), dotation consommée',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl, { humanVerified: true })
        sql(env, `insert into wm.grace_grants (user_id, size, reason) values (:'uid', 3, 'contrat')`, uid)
        assert.equal((await ok(await post(env, '/api/packs/grace', uid), Cards)).cards.length, 3)
        assert.equal(sql(env, `select claimed_at is not null from wm.grace_grants where user_id = :'uid'`, uid), 't')
      },
    },
  ],
}

export const packs: RouteSpec[] = [packsOpen, humanCheck, proDailyStatus, proDailyClaim, specialList, specialClaim, grace]
