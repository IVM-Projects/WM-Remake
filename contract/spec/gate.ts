import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { GATE_COOKIE, gateToken } from '../../lib/gate.ts'
import { GATE } from '../harness.ts'
import { generateKeys, sessionCookie, signJwt } from '../jwt.ts'

const Denied = z.object({ error: z.literal('Accès réservé'), message: z.literal('Accès réservé') })

// Toute réponse du serveur à porte porte le noindex, redirections comprises.
async function get(base: string, path: string, cookies: string[] = []): Promise<Response> {
  const res = await fetch(base + path, { redirect: 'manual', headers: { cookie: cookies.join('; ') } })
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', `X-Robots-Tag de ${path}`)
  return res
}

function assertRedirect(res: Response, status: number, base: string, target: string): void {
  assert.equal(res.status, status)
  assert.equal(new URL(res.headers.get('location') ?? '', base).href, new URL(target, base).href)
}

const gateCookie = async () => `${GATE_COOKIE}=${await gateToken(GATE.secret, GATE.password)}`

function session(backend: ContractEnv['backend'], privateJwk = backend.privateJwk): string {
  const uid = '00000000-0000-0000-0000-0000000000c1'
  const now = Math.floor(Date.now() / 1000)
  const jwt = signJwt(privateJwk, { sub: uid, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })
  const { name, value } = sessionCookie(backend.supabaseUrl, jwt, uid)
  return `${name}=${value}`
}

// Porte démo (serveur `gated`) : comportement transverse, hors recap.
export const gate: RouteSpec = {
  method: 'GET',
  path: '/*',
  source: 'D§3.4 · D§8.5',
  confidence: 'ajouté',
  cases: [
    {
      name: 'sans cookie : / → 307 /gate?next=%2F',
      run: async ({ gated }) => assertRedirect(await get(gated, '/'), 307, gated, '/gate?next=%2F'),
    },
    {
      name: 'sans cookie : /marketplace/x.png → 307 /gate (aucune exemption par extension)',
      run: async ({ gated }) => assertRedirect(await get(gated, '/marketplace/x.png'), 307, gated, '/gate?next=%2Fmarketplace%2Fx.png'),
    },
    {
      name: 'sans cookie : /api/marketplace → 401 JSON « Accès réservé »',
      run: async ({ gated }) => {
        const res = await get(gated, '/api/marketplace')
        assert.equal(res.status, 401)
        Denied.parse(await res.json())
      },
    },
    {
      name: 'sans cookie : /api/health (exemptée) → 200',
      run: async ({ gated }) => assert.equal((await get(gated, '/api/health')).status, 200),
    },
    {
      name: 'sans cookie : /api/cron/nope → 404 titré « Page introuvable », sans la marque',
      run: async ({ gated }) => {
        const res = await get(gated, '/api/cron/nope')
        assert.equal(res.status, 404)
        assert.deepEqual([...(await res.text()).matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]), ['Page introuvable'])
      },
    },
    {
      name: 'sans cookie : /sw.js (exempté, M4b-23) → 200 JavaScript, gestionnaire push, aucun gestionnaire fetch',
      run: async ({ gated }) => {
        const res = await get(gated, '/sw.js')
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type') ?? '', /javascript/)
        const body = await res.text()
        assert.ok(body.includes('addEventListener(\'push\''), 'gestionnaire push')
        assert.ok(!body.includes('addEventListener(\'fetch\''), 'aucun gestionnaire fetch')
      },
    },
    {
      name: '/robots.txt interdit tout',
      run: async ({ gated }) => assert.match(await (await get(gated, '/robots.txt')).text(), /^Disallow: \/$/m),
    },
    {
      name: '/pull → 308 /pulls',
      run: async ({ gated }) => assertRedirect(await get(gated, '/pull'), 308, gated, '/pulls'),
    },
    {
      name: 'cookie de porte valide, sans session : /collection → 307 /login?next=%2Fcollection',
      run: async ({ gated }) => assertRedirect(await get(gated, '/collection', [await gateCookie()]), 307, gated, '/login?next=%2Fcollection'),
    },
    {
      name: 'cookie de porte et session signée par la clé du JWKS : /collection sans renvoi vers /login',
      run: async ({ gated, backend }) => {
        const res = await get(gated, '/collection', [await gateCookie(), session(backend)])
        assert.equal(res.headers.get('location'), null)
      },
    },
    {
      name: 'session signée par une autre clé : /collection → 307 /login?next=%2Fcollection',
      run: async ({ gated, backend }) => {
        const res = await get(gated, '/collection', [await gateCookie(), session(backend, generateKeys().privateJwk)])
        assertRedirect(res, 307, gated, '/login?next=%2Fcollection')
      },
    },
  ],
}
