import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RouteSpec } from '../../lib/contract.ts'
import { latestMail, latestOtp } from '../mail.ts'

const KEY = 'sb_publishable_test'

// GoTrue derrière la passerelle, comme supabase-js : clé publiable en apikey.
function gotrue(supabaseUrl: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${supabaseUrl}/auth/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { apikey: KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// Inscription confirmée par le code reçu dans Mailpit : session GoTrue du nouveau joueur.
async function signUp(supabaseUrl: string): Promise<{ email: string; password: string; accessToken: string }> {
  const email = `${randomUUID()}@test.local`
  const password = 'mot-de-passe-de-test'
  const data = { username: `a_${randomUUID().slice(-12)}`, age_confirmed: true, terms_version: 'test' }
  const signup = await gotrue(supabaseUrl, '/signup', { email, password, data })
  assert.equal(signup.status, 200, await signup.text())
  // Modèle FR servi par la passerelle : GoTrue retombe en silence sur le sien s'il ne le lit pas.
  const mail = await latestMail(email)
  assert.equal(mail.subject, 'Ton code de confirmation')
  assert.match(mail.text, /Il expire dans une heure/)
  const verify = await gotrue(supabaseUrl, '/verify', { type: 'signup', email, token: await latestOtp(email) })
  assert.equal(verify.status, 200)
  const { access_token: accessToken } = (await verify.json()) as { access_token: string }
  return { email, password, accessToken }
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
      name: 'inscription → code à 6 chiffres reçu dans Mailpit → verify → JWT ES256 du kid du banc, accepté par PostgREST',
      run: async ({ backend }) => {
        const { accessToken } = await signUp(backend.supabaseUrl)
        const { alg, kid } = JSON.parse(Buffer.from(accessToken.split('.')[0], 'base64url').toString()) as { alg: string; kid: string }
        assert.deepEqual({ alg, kid }, { alg: 'ES256', kid: 'wm-test-es256' })
        const res = await fetch(`${backend.supabaseUrl}/rest/v1/cards?select=id&limit=1`, {
          headers: { apikey: KEY, authorization: `Bearer ${accessToken}` },
        })
        assert.equal(res.status, 200, await res.text())
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
  ],
}
