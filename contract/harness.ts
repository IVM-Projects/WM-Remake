// Banc de contrat : PG local (db-test.sh) + PostgREST + passerelle imitant Supabase + `next start`.
// Lancé aussi par `node contract/serve.ts` : imports relatifs en .ts seulement, aucun alias @/.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { generateKeys, signJwt } from './jwt.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const cache = `${root}.cache`
const SUPABASE_URL = 'http://127.0.0.1:54321' // figée dans le build par `npm run build:test`
const POSTGREST_PORT = 54322
const STARTUP_MS = 120_000
// Clés de test uniquement (build:test) ; la passerelle les échange contre un JWT du rôle, comme Supabase.
const KEY_ROLES = new Map([['sb_publishable_test', 'anon'], ['sb_secret_test', 'service_role']])
export const GATE = { password: 'test-gate', secret: 'test-secret' }

export type Backend = { supabaseUrl: typeof SUPABASE_URL; databaseUrl: string; privateJwk: JsonWebKey; stop(): Promise<void> }
type Stop = () => Promise<void>

function assertFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer().once('error', () => reject(new Error(`port ${port} occupé (processus d'un run précédent ?)`)))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
}

function spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  mkdirSync(`${cache}/logs`, { recursive: true })
  const log = openSync(`${cache}/logs/${name}.log`, 'w')
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', log, log] })
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

function gateway(privateJwk: JsonWebKey, publicJwk: JsonWebKey): Server {
  const jwks = JSON.stringify({ keys: [publicJwk] })
  return createServer((req, res) => {
    const json = (status: number, body: string) => void res.writeHead(status, { 'content-type': 'application/json' }).end(body)
    // auth-js getClaims() vérifie localement le JWT avec la clé de ce JWKS (même kid).
    if (req.method === 'GET' && req.url === '/auth/v1/.well-known/jwks.json') return json(200, jwks)
    if (!req.url?.startsWith('/rest/v1/')) return json(404, '{"message":"no Route matched with those values"}')
    const apikey = String(req.headers.apikey)
    if (!KEY_ROLES.has(apikey)) return json(401, '{"message":"Invalid API key"}')
    // Clé en Bearer, ou pas d'Authorization : JWT du rôle de la clé ; tout autre bearer (JWT utilisateur) passe tel quel.
    const bearer = req.headers.authorization?.replace(/^Bearer /i, '') || apikey
    const role = KEY_ROLES.get(bearer)
    const now = Math.floor(Date.now() / 1000)
    const token = role ? signJwt(privateJwk, { iss: 'supabase', role, iat: now, exp: now + 3600 }) : bearer
    const headers = { ...req.headers, host: `127.0.0.1:${POSTGREST_PORT}`, authorization: `Bearer ${token}` }
    const upstream = request(
      { host: '127.0.0.1', port: POSTGREST_PORT, method: req.method, path: req.url.slice('/rest/v1'.length), headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', () => (res.headersSent ? res.destroy() : json(502, '{"message":"PostgREST injoignable"}')))
    req.pipe(upstream)
  })
}

export async function startBackend(): Promise<Backend> {
  const stops: Stop[] = []
  try {
    await Promise.all([54321, POSTGREST_PORT].map(assertFree))
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
    })
    stops.push(() => kill(postgrest))
    await waitReady('postgrest', postgrest, `http://127.0.0.1:${POSTGREST_PORT}/`)

    const server = gateway(privateJwk, publicJwk)
    stops.push(() => new Promise((resolve) => void server.close(() => resolve()).closeAllConnections()))
    await once(server.listen(54321, '127.0.0.1'), 'listening')

    // Pour les fixtures E2E (Task 10) ; supprimé à l'arrêt pour ne jamais servir une clé périmée.
    writeFileSync(`${cache}/backend.json`, JSON.stringify({ supabaseUrl: SUPABASE_URL, databaseUrl, privateJwk }))
    stops.push(async () => rmSync(`${cache}/backend.json`, { force: true }))
    return { supabaseUrl: SUPABASE_URL, databaseUrl, privateJwk, stop: () => stopAll(stops) }
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
