// Joueurs du banc : créés par psql via tests.make_user (vrai auth.users), session en cookie signé de la clé du banc.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Backend } from './harness.ts'
import { sessionCookie, signJwt } from './jwt.ts'

export function makeUser(
  databaseUrl: string,
  opts: { username?: string; balance?: number; pro?: boolean } = {},
): { uid: string; username: string } {
  const username = opts.username ?? `u_${randomUUID().slice(-12)}`
  // Variables psql (:'nom') : valeurs citées par psql, aucune concaténation SQL.
  const vars = { username, balance: String(opts.balance ?? 0), pro: String(opts.pro ?? false) }
  const uid = execFileSync('psql', [databaseUrl, '-qXAt', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])], {
    encoding: 'utf8',
    input: `select tests.make_user(:'username', :'balance') as uid \\gset
update public.profiles set is_pro = :'pro' where id = :'uid';
\\echo :uid
`,
  }).trim()
  return { uid, username }
}

export function authCookie(backend: Pick<Backend, 'supabaseUrl' | 'privateJwk'>, uid: string): { name: string; value: string } {
  const now = Math.floor(Date.now() / 1000)
  const jwt = signJwt(backend.privateJwk, { sub: uid, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })
  return sessionCookie(backend.supabaseUrl, jwt, uid)
}
