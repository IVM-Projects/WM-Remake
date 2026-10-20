// Joueurs du banc : créés par psql via tests.make_user (vrai auth.users), session en cookie signé de la clé du banc.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

export function authCookie(backend: Pick<Backend, 'supabaseUrl' | 'privateJwk'>, uid: string): { name: string; value: string } {
  const now = Math.floor(Date.now() / 1000)
  const jwt = signJwt(backend.privateJwk, { sub: uid, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })
  return sessionCookie(backend.supabaseUrl, jwt, uid)
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
