import { createPrivateKey, generateKeyPairSync, sign, type JsonWebKey as NodeJwk } from 'node:crypto'

// kid fixe : getClaims() (auth-js) cherche la clé du JWKS par kid, PostgREST aussi.
const KID = 'wm-test-es256'

export function generateKeys(): { privateJwk: JsonWebKey; publicJwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const meta = { kid: KID, alg: 'ES256', use: 'sig' }
  return {
    privateJwk: { ...privateKey.export({ format: 'jwk' }), ...meta },
    publicJwk: { ...publicKey.export({ format: 'jwk' }), ...meta },
  }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export function signJwt(privateJwk: JsonWebKey, claims: Record<string, unknown>): string {
  const input = `${b64url({ alg: 'ES256', typ: 'JWT', kid: KID })}.${b64url(claims)}`
  const key = createPrivateKey({ key: privateJwk as NodeJwk, format: 'jwk' }) // JsonWebKey du DOM sans signature d'index
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

// Cookie de session @supabase/ssr par défaut : `sb-<1er label de l'hôte>-auth-token`, valeur `base64-` + base64url(JSON).
export function sessionCookie(supabaseUrl: string, accessToken: string, uid: string): { name: string; value: string } {
  const { exp } = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as { exp: number }
  const session = {
    access_token: accessToken,
    refresh_token: 'contract-refresh-token', // jamais utilisé : pas de GoTrue, expires_at doit rester loin
    expires_at: exp,
    expires_in: exp - Math.floor(Date.now() / 1000),
    token_type: 'bearer',
    user: { id: uid },
  }
  return { name: `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`, value: `base64-${b64url(session)}` }
}
