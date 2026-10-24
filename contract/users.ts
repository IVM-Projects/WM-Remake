// Joueurs du banc : créés par psql via tests.make_user (vrai auth.users), session en cookie signé de la clé du banc.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv } from '../lib/contract.ts'
import type { Backend } from './harness.ts'
import { sessionCookie, signJwt } from './jwt.ts'

// Variables psql (:'nom') : valeurs citées par psql, aucune concaténation SQL.
export function psql(databaseUrl: string, sql: string, vars: Record<string, string> = {}): string {
  const args = [databaseUrl, '-qXAt', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])]
  return execFileSync('psql', args, { encoding: 'utf8', input: sql }).trim()
}

export function makeUser(
  databaseUrl: string,
  opts: { username?: string; balance?: number; pro?: boolean; humanVerified?: boolean } = {},
): { uid: string; username: string } {
  const username = opts.username ?? `u_${randomUUID().slice(-12)}`
  const vars = { username, balance: String(opts.balance ?? 0), pro: String(opts.pro ?? false), human: String(opts.humanVerified ?? false) }
  const uid = psql(databaseUrl, `select tests.make_user(:'username', :'balance') as uid \\gset
update public.profiles set is_pro = :'pro' where id = :'uid';
insert into wm.user_state (user_id, human_verified_until) select :'uid'::uuid, now() + interval '12 hours' where :'human'::boolean
on conflict (user_id) do update set human_verified_until = excluded.human_verified_until;
\\echo :uid
`, vars)
  return { uid, username }
}

// JWT du joueur, celui du cookie : aussi le Bearer des appels directs à /rest/v1.
export function accessToken(backend: Pick<Backend, 'privateJwk'>, uid: string): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(backend.privateJwk, { sub: uid, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })
}

export function authCookie(backend: Pick<Backend, 'supabaseUrl' | 'privateJwk'>, uid: string): { name: string; value: string } {
  return sessionCookie(backend.supabaseUrl, accessToken(backend, uid), uid)
}

// n copies des n premières cartes du seed de cette rareté (ordre du titre) ; renvoie les ids des copies.
export function giveCards(databaseUrl: string, uid: string, rarity: string, n = 1): string[] {
  return psql(databaseUrl, `insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where rarity = :'rarity' order by wikipedia_title limit :'n'::int
returning id`, { uid, rarity, n: String(n) }).split('\n')
}

// Route du serveur sans porte, en session de `uid` s'il est donné (cookie, comme le navigateur et les extensions).
export function api(
  env: ContractEnv,
  path: string,
  init: { method?: string; uid?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const cookie = init.uid && authCookie(env.backend, init.uid)
  return fetch(env.plain + path, {
    method: init.method ?? 'GET',
    headers: { ...(cookie && { cookie: `${cookie.name}=${cookie.value}` }), 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

// api() en arguments positionnels ; idem() : une Idempotency-Key neuve à passer en `headers`.
export const send = (env: ContractEnv, method: string, path: string, uid?: string, body?: unknown, headers?: Record<string, string>) =>
  api(env, path, { method, uid, body, headers })
export const idem = () => ({ 'Idempotency-Key': randomUUID() })

export const RARITIES = ['C', 'PC', 'R', 'SR', 'UR', 'L'] as const
export const Rarity = z.enum(RARITIES)
export const Iso = z.iso.datetime({ offset: true })

// Corps D§8.2 : error = message, code exact (absent si non donné) ; renvoie le corps pour ses clés en plus.
// Statut vérifié avant JSON.parse : une page HTML (404, 500) s'affiche avec son statut.
async function bodyOf(res: Response, status: number): Promise<unknown> {
  const text = await res.text()
  assert.equal(res.status, status, `${res.status} ${text.slice(0, 500)}`)
  return JSON.parse(text)
}

export async function failed(res: Response, status: number, code?: string): Promise<Record<string, unknown>> {
  const body = (await bodyOf(res, status)) as Record<string, unknown>
  assert.equal(typeof body.error, 'string')
  assert.equal(body.message, body.error)
  assert.equal(body.code, code)
  return body
}

// Corps entier de l'erreur (wm.raise_err ou zod via route()) : code s'il est donné, error = message, aucune autre clé.
export async function refused(res: Response, status: number, error: string, code?: string): Promise<void> {
  assert.deepEqual(await failed(res, status, code), { ...(code && { code }), error, message: error })
}

export async function ok<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await bodyOf(res, 200))
}

// ok() d'une création (201).
export async function created<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await bodyOf(res, 201))
}

// Cas commun des routes authentifiées.
export const noSession = (method: string, path: string) => ({
  name: 'sans session → 401 unauthorized (D§8.2)',
  run: async (env: ContractEnv) => void (await failed(await api(env, path, { method }), 401, 'unauthorized')),
})
