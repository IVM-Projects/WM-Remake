import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RouteSpec } from '../../lib/contract.ts'
import { latestMail, latestOtp } from '../mail.ts'
import { authCookie, makeUser, psql } from '../users.ts'

const KEY = 'sb_publishable_test'

// GoTrue derrière la passerelle, comme supabase-js : clé publiable en apikey.
function gotrue(supabaseUrl: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${supabaseUrl}/auth/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { apikey: KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const signupBody = (username: string) =>
  ({ email: `${randomUUID()}@test.local`, password: 'mot-de-passe-de-test', data: { username, age_confirmed: true, terms_version: 'test' } })

// Inscription confirmée par le code reçu dans Mailpit : session GoTrue du nouveau joueur.
async function signUp(supabaseUrl: string): Promise<{ email: string; password: string; username: string; accessToken: string }> {
  const body = signupBody(`a_${randomUUID().slice(-12)}`)
  const { email, password, data: { username } } = body
  const signup = await gotrue(supabaseUrl, '/signup', body)
  assert.equal(signup.status, 200, await signup.text())
  // Modèle FR servi par la passerelle : GoTrue retombe en silence sur le sien s'il ne le lit pas.
  const mail = await latestMail(email)
  assert.equal(mail.subject, 'Ton code de confirmation')
  assert.match(mail.text, /Il expire dans une heure/)
  const verify = await gotrue(supabaseUrl, '/verify', { type: 'signup', email, token: await latestOtp(email) })
  assert.equal(verify.status, 200)
  const { access_token: accessToken } = (await verify.json()) as { access_token: string }
  return { email, password, username, accessToken }
}

// GoTrue lui-même (R§3.11) : seules les routes qu'emprunte l'app, hors recap des routes /api.
export const auth: RouteSpec = {
  method: 'POST',
  path: '/auth/v1/*',
  source: 'R§3.11',
  confidence: 'conf.',
  cases: [
    {
      name: 'GET /auth/v1/health via la passerelle → 200 et version v2.197.0',
      run: async ({ backend }) => {
        const res = await gotrue(backend.supabaseUrl, '/health')
        assert.equal(res.status, 200)
        assert.equal(((await res.json()) as { version: string }).version, 'v2.197.0')
      },
    },
    {
      name: 'inscription → code à 6 chiffres reçu dans Mailpit → verify → JWT ES256 du kid du banc, accepté par PostgREST : profiles = le pseudo choisi',
      run: async ({ backend }) => {
        const { username, accessToken } = await signUp(backend.supabaseUrl)
        const { alg, kid } = JSON.parse(Buffer.from(accessToken.split('.')[0], 'base64url').toString()) as { alg: string; kid: string }
        assert.deepEqual({ alg, kid }, { alg: 'ES256', kid: 'wm-test-es256' })
        const res = await fetch(`${backend.supabaseUrl}/rest/v1/profiles?select=username`, {
          headers: { apikey: KEY, authorization: `Bearer ${accessToken}` },
        })
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), [{ username }]) // profil créé par le trigger d'inscription
      },
    },
    {
      name: 'pseudo pris (autre casse) → statut ≥ 400, « Ce pseudo est déjà pris » dans le corps',
      run: async ({ backend }) => {
        const { username } = makeUser(backend.databaseUrl)
        const res = await gotrue(backend.supabaseUrl, '/signup', signupBody(username.toUpperCase()))
        const text = await res.text()
        assert.ok(res.status >= 400, `${res.status} ${text}`)
        assert.match(text, /Ce pseudo est déjà pris/)
      },
    },
    {
      name: 'deux inscriptions simultanées du même pseudo → une seule réussit, un seul profil',
      run: async ({ backend }) => {
        const username = `s_${randomUUID().slice(-12)}`
        const results = await Promise.all([0, 1].map(async () => {
          const res = await gotrue(backend.supabaseUrl, '/signup', signupBody(username))
          return { status: res.status, text: await res.text() }
        }))
        assert.deepEqual(results.map((r) => r.status >= 400).sort(), [false, true], JSON.stringify(results))
        assert.match(results.find((r) => r.status >= 400)!.text, /Ce pseudo est déjà pris/)
        assert.equal(psql(backend.databaseUrl, `select count(*) from public.profiles where lower(username) = lower(:'u')`, { u: username }), '1')
      },
    },
    {
      name: 'connexion par mot de passe → session',
      run: async ({ backend }) => {
        const { email, password } = await signUp(backend.supabaseUrl)
        const res = await gotrue(backend.supabaseUrl, '/token?grant_type=password', { email, password })
        assert.equal(res.status, 200)
        assert.equal(typeof ((await res.json()) as { access_token?: unknown }).access_token, 'string')
      },
    },
    {
      name: 'joueur de makeUser : le jeton de son authCookie → GET /auth/v1/user 200, même id (ligne auth.users lisible par GoTrue)',
      run: async ({ backend }) => {
        const { uid } = makeUser(backend.databaseUrl)
        const { value } = authCookie(backend, uid)
        const { access_token } = JSON.parse(Buffer.from(value.slice('base64-'.length), 'base64url').toString()) as { access_token: string }
        const res = await fetch(`${backend.supabaseUrl}/auth/v1/user`, { headers: { apikey: KEY, authorization: `Bearer ${access_token}` } })
        assert.equal(res.status, 200, await res.clone().text())
        assert.equal(((await res.json()) as { id: string }).id, uid)
      },
    },
  ],
}
