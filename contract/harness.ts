// Banc de contrat : PG local (db-test.sh) + PostgREST + Mailpit + GoTrue + passerelle imitant Supabase + `next start`.
// Lancé aussi par `node contract/serve.ts` : imports relatifs en .ts seulement, aucun alias @/.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { generateKeys, signJwt } from './jwt.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const cache = `${root}.cache`
const SUPABASE_URL = 'http://127.0.0.1:54321' // figée dans le build par `npm run build:test`
const POSTGREST_PORT = 54322
const GOTRUE_PORT = 54323
export const MAILPIT_URL = 'http://127.0.0.1:54324'
const MAILPIT_SMTP_PORT = 54325
const STARTUP_MS = 120_000
// Clés de test uniquement (build:test) ; la passerelle les échange contre un JWT du rôle, comme Supabase.
const KEY_ROLES = new Map([['sb_publishable_test', 'anon'], ['sb_secret_test', 'service_role']])
export const GATE = { password: 'test-gate', secret: 'test-secret' }

// Vérificateur Turnstile du banc (POST /turnstile/siteverify) : seul ce couple est accepté.
const TURNSTILE = { secret: 'test-turnstile', response: 'dev-bypass' }

export type Backend = {
  supabaseUrl: typeof SUPABASE_URL
  databaseUrl: string
  mailpitUrl: typeof MAILPIT_URL
  privateJwk: JsonWebKey
  stop(): Promise<void>
}
type Stop = () => Promise<void>

function assertFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer().once('error', () => reject(new Error(`port ${port} occupé (processus d'un run précédent ?)`)))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
}

function spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd = root): ChildProcess {
  mkdirSync(`${cache}/logs`, { recursive: true })
  const log = openSync(`${cache}/logs/${name}.log`, 'w')
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', log, log] })
  closeSync(log)
  return child
}

// Prêt dès la première réponse HTTP autre que 503 (PostgREST charge encore son cache de schéma).
async function waitReady(name: string, child: ChildProcess, url: string): Promise<void> {
  const state: { failure?: string } = {}
  child.once('error', (e) => (state.failure = e.message))
  child.once('exit', (code, signal) => (state.failure ??= `arrêté (${code ?? signal})`))
  const deadline = Date.now() + STARTUP_MS
  while (!state.failure && Date.now() < deadline) {
    if (await fetch(url).then((r) => r.status !== 503, () => false)) return
    await sleep(250)
  }
  const log = readFileSync(`${cache}/logs/${name}.log`, 'utf8').slice(-2000)
  throw new Error(`${name} : ${state.failure ?? `pas prêt en ${STARTUP_MS / 1000} s`}\n${log}`)
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit').catch(() => {})
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  await exited
  clearTimeout(timer)
}

async function stopAll(stops: Stop[]): Promise<void> {
  for (const stop of stops.splice(0).reverse()) await stop().catch((e: unknown) => console.error(e))
}

// Supabase laisse ouvertes sans apikey les routes GoTrue suivies depuis un lien d'e-mail ou lues par tous (JWKS).
const OPEN_AUTH = /^\/auth\/v1\/(verify|\.well-known\/jwks\.json)(\?|$)/
const UPSTREAMS = [['/rest/v1', POSTGREST_PORT], ['/auth/v1', GOTRUE_PORT]] as const

function gateway(privateJwk: JsonWebKey): Server {
  return createServer((req, res) => {
    const json = (status: number, body: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    const url = req.url ?? '/'
    // Modèles d'e-mail lus par GoTrue (GOTRUE_MAILER_TEMPLATES_*) ; nom restreint, donc aucun `..`.
    const template = req.method === 'GET' && /^\/templates\/([a-z]+)\.html$/.exec(url)
    if (template) {
      const file = `${root}supabase/templates/${template[1]}.html`
      if (!existsSync(file)) return json(404, { message: 'modèle inconnu' })
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(file))
    }
    if (req.method === 'POST' && url === '/turnstile/siteverify') {
      let body = ''
      req.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
      return void req.on('end', () => {
        const form = new URLSearchParams(body)
        const ok = form.get('secret') === TURNSTILE.secret && form.get('response') === TURNSTILE.response
        json(200, ok ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] })
      })
    }
    // Préflight CORS du navigateur (jamais d'apikey) : la passerelle y répond, comme le plugin cors de Kong chez Supabase.
    // GoTrue refuserait l'en-tête apikey ; ses réponses portent déjà Access-Control-Allow-Origin: *.
    if (req.method === 'OPTIONS') {
      return void res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '',
        'access-control-max-age': '3600',
      }).end()
    }
    const upstream = UPSTREAMS.find(([prefix]) => url.startsWith(`${prefix}/`))
    if (!upstream) return json(404, { message: 'no Route matched with those values' })
    const [prefix, port] = upstream
    const apikey = String(req.headers.apikey)
    const headers = { ...req.headers, host: `127.0.0.1:${port}` }
    if (KEY_ROLES.has(apikey)) {
      // Clé en Bearer, ou pas d'Authorization : JWT du rôle de la clé ; tout autre bearer (JWT utilisateur) passe tel quel.
      const bearer = req.headers.authorization?.replace(/^Bearer /i, '') || apikey
      const role = KEY_ROLES.get(bearer)
      const now = Math.floor(Date.now() / 1000)
      headers.authorization = `Bearer ${role ? signJwt(privateJwk, { iss: 'supabase', role, iat: now, exp: now + 3600 }) : bearer}`
    } else if (!(req.method === 'GET' && OPEN_AUTH.test(url))) return json(401, { message: 'Invalid API key' })
    const proxied = request({ host: '127.0.0.1', port, method: req.method, path: url.slice(prefix.length), headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    proxied.on('error', () => (res.headersSent ? res.destroy() : json(502, { message: `${prefix} injoignable` })))
    req.pipe(proxied)
  })
}

export async function startBackend(): Promise<Backend> {
  const stops: Stop[] = []
  try {
    await Promise.all([54321, POSTGREST_PORT, GOTRUE_PORT, 54324, MAILPIT_SMTP_PORT].map(assertFree))
    // Cluster jetable .cache/pg, ou base wm_test recréée sur le serveur de $DATABASE_URL (CI).
    const out = execFileSync('bash', [`${root}scripts/db-test.sh`, '--setup-only'], { encoding: 'utf8' })
    const databaseUrl = out.trim().replace(/^DATABASE_URL=/, '')
    stops.push(async () => void execFileSync('bash', [`${root}scripts/db-test.sh`, '--stop']))

    const { privateJwk, publicJwk } = generateKeys()
    const dbUri = new URL(databaseUrl)
    dbUri.username = 'authenticator' // mot de passe de test de bootstrap_local.sql
    dbUri.password = 'authenticator'
    const postgrest = spawnLogged('postgrest', `${cache}/postgrest/postgrest`, [], {
      ...process.env,
      PGRST_DB_URI: dbUri.href,
      PGRST_DB_SCHEMAS: 'public,wm',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: JSON.stringify({ keys: [publicJwk] }), // PostgREST accepte un JWKS (vérifié ES256 sur v12.2.3)
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: String(POSTGREST_PORT),
      PGRST_DB_MAX_ROWS: '1000', // D§8.1 n° 3
    })
    stops.push(() => kill(postgrest))
    await waitReady('postgrest', postgrest, `http://127.0.0.1:${POSTGREST_PORT}/`)

    const mailpit = spawnLogged('mailpit', `${cache}/mailpit/mailpit`, ['--smtp', `127.0.0.1:${MAILPIT_SMTP_PORT}`, '--listen', '127.0.0.1:54324', '--disable-version-check'], process.env)
    stops.push(() => kill(mailpit))
    await waitReady('mailpit', mailpit, `${MAILPIT_URL}/api/v1/info`)

    const authUri = new URL(databaseUrl)
    authUri.username = 'supabase_auth_admin' // mot de passe de test de bootstrap_local.sql
    authUri.password = 'auth'
    const templates = `${SUPABASE_URL}/templates`
    // Limites relevées par `strings auth | grep GOTRUE_RATE_LIMIT` : EMAIL_SENT, VERIFY, TOKEN_REFRESH, OTP.
    const rateLimits = Object.fromEntries(['EMAIL_SENT', 'VERIFY', 'TOKEN_REFRESH', 'OTP'].map((k) => [`GOTRUE_RATE_LIMIT_${k}`, '10000']))
    const gotrue = spawnLogged('gotrue', `${cache}/gotrue/auth`, ['serve'], {
      ...process.env,
      ...rateLimits,
      GOTRUE_DB_DRIVER: 'postgres',
      DATABASE_URL: authUri.href,
      GOTRUE_API_HOST: '127.0.0.1',
      PORT: String(GOTRUE_PORT),
      API_EXTERNAL_URL: `${SUPABASE_URL}/auth/v1`,
      GOTRUE_SITE_URL: 'http://127.0.0.1:3100',
      GOTRUE_URI_ALLOW_LIST: 'http://127.0.0.1:3100/**,http://127.0.0.1:3101/**',
      GOTRUE_JWT_SECRET: 'banc-de-test-secret-hs256-inutilise-32c', // exigé, inutilisé : GoTrue signe avec GOTRUE_JWT_KEYS
      GOTRUE_JWT_KEYS: JSON.stringify([privateJwk]),
      GOTRUE_JWT_EXP: '3600',
      GOTRUE_JWT_AUD: 'authenticated',
      GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      GOTRUE_JWT_ADMIN_ROLES: 'service_role',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
      GOTRUE_MAILER_AUTOCONFIRM: 'false',
      GOTRUE_MAILER_OTP_LENGTH: '6',
      GOTRUE_MAILER_OTP_EXP: '3600', // « Il expire dans une heure » (confirmation.html), défaut de Supabase hébergé
      GOTRUE_SMTP_HOST: '127.0.0.1',
      GOTRUE_SMTP_PORT: String(MAILPIT_SMTP_PORT),
      GOTRUE_SMTP_ADMIN_EMAIL: 'noreply@wikicartes.test',
      GOTRUE_SMTP_SENDER_NAME: 'WikiCartes',
      GOTRUE_SMTP_MAX_FREQUENCY: '1s', // défaut 60 s : « Renvoyer le code » prendrait 429 over_email_send_rate_limit
      // Liens d'e-mail résolus sur l'hôte d'API_EXTERNAL_URL sans son chemin (comme le docker-compose de Supabase).
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
      GOTRUE_MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: `${templates}/confirmation.html`,
      GOTRUE_MAILER_TEMPLATES_RECOVERY: `${templates}/recovery.html`,
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: 'Ton code de confirmation',
      GOTRUE_MAILER_SUBJECTS_RECOVERY: 'Choisis un nouveau mot de passe',
      GOTRUE_SECURITY_CAPTCHA_ENABLED: 'false',
      GOTRUE_LOG_LEVEL: 'warn',
    }, `${cache}/gotrue`) // lit ./migrations
    stops.push(() => kill(gotrue))
    await waitReady('gotrue', gotrue, `http://127.0.0.1:${GOTRUE_PORT}/health`)

    const server = gateway(privateJwk)
    stops.push(() => new Promise((resolve) => void server.close(() => resolve()).closeAllConnections()))
    await once(server.listen(54321, '127.0.0.1'), 'listening')

    // Pour les fixtures E2E (Task 10) ; supprimé à l'arrêt pour ne jamais servir une clé périmée.
    const backend: Omit<Backend, 'stop'> = { supabaseUrl: SUPABASE_URL, databaseUrl, mailpitUrl: MAILPIT_URL, privateJwk }
    writeFileSync(`${cache}/backend.json`, JSON.stringify(backend))
    stops.push(async () => rmSync(`${cache}/backend.json`, { force: true }))
    return { ...backend, stop: () => stopAll(stops) }
  } catch (e) {
    await stopAll(stops)
    throw e
  }
}

export async function startNext(name: 'plain' | 'gated', backend: Backend): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = name === 'plain' ? 3100 : 3101
  await assertFree(port)
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawnLogged(`next-${name}`, process.execPath, [`${root}node_modules/next/dist/bin/next`, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    ...process.env,
    NODE_ENV: 'production', // vitest exporte NODE_ENV=test
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: backend.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    DEMO_GATE_PASSWORD: name === 'gated' ? GATE.password : undefined, // undefined : variable absente du processus
    GATE_COOKIE_SECRET: name === 'gated' ? GATE.secret : undefined,
    TURNSTILE_SECRET_KEY: TURNSTILE.secret,
    TURNSTILE_VERIFY_URL: `${backend.supabaseUrl}/turnstile/siteverify`,
  })
  const stop = () => kill(child)
  try {
    await waitReady(`next-${name}`, child, `${baseUrl}/api/health`)
  } catch (e) {
    await stop()
    throw e
  }
  return { baseUrl, stop }
}

// Backend + les deux serveurs Next (même build) ; un échec arrête ce qui tourne déjà.
export async function startStack(): Promise<{ backend: Backend; plain: string; gated: string; stop(): Promise<void> }> {
  const backend = await startBackend()
  const stops: Stop[] = [backend.stop]
  try {
    const plain = await startNext('plain', backend)
    stops.push(plain.stop)
    const gated = await startNext('gated', backend)
    stops.push(gated.stop)
    return { backend, plain: plain.baseUrl, gated: gated.baseUrl, stop: () => stopAll(stops) }
  } catch (e) {
    await stopAll(stops)
    throw e
  }
}
