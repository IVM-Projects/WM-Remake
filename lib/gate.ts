export const GATE_COOKIE = 'wm_gate'

// Chemins bruts exacts : aucune normalisation, donc `/GATE` ou `/api/health/` ne passent pas.
const EXEMPT = new Set(['/gate', '/api/health', '/api/stripe/webhook', '/robots.txt', '/icon'])

// Seule définition de « porte active » (proxy, next.config, layout, robots) : les deux variables, ou aucune.
// Une seule définie lève (fail-closed) au lieu d'ouvrir la porte. Lues à l'appel.
export function gateEnv(): { password: string; secret: string } | null {
  const password = process.env.DEMO_GATE_PASSWORD
  const secret = process.env.GATE_COOKIE_SECRET
  if (!password !== !secret) throw new Error('Porte démo à moitié configurée : définis DEMO_GATE_PASSWORD et GATE_COOKIE_SECRET, ou aucune des deux')
  return password && secret ? { password, secret } : null
}

export async function gateToken(secret: string, password: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`gate:v1:${password}`))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Temps constant sur des jetons de longueur fixe (64 hex) : seule la longueur, publique, peut fuiter.
export async function isGateCookieValid(value: string | undefined, secret: string, password: string): Promise<boolean> {
  const expected = await gateToken(secret, password)
  if (value?.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= value.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

export function gateDecision(pathname: string, gateEnabled: boolean, cookieValid: boolean): 'pass' | 'redirect' | 'unauthorized' {
  if (!gateEnabled || cookieValid || EXEMPT.has(pathname)) return 'pass'
  // `..` refusé : un routeur qui normaliserait après coup ne doit pas sortir de /api/cron/.
  if (pathname.startsWith('/api/cron/') && !pathname.includes('..')) return 'pass'
  return pathname.startsWith('/api/') ? 'unauthorized' : 'redirect'
}

const ORIGIN = 'http://gate.invalid'

// Résout comme le navigateur (`\` = `/`, tabulations retirées) : seule une cible de même origine est gardée,
// et jamais un chemin `//…` (protocole relatif) que la résolution des `.`/`..` peut produire (`/.//evil`).
export function safeNext(next: string | null | undefined): string {
  // canParse et non URL.parse (importé par le client) : Next ne polyfille que canParse, URL.parse manque sous Safari < 18 et Chrome < 126.
  const url = next && URL.canParse(next, ORIGIN) ? new URL(next, ORIGIN) : null
  return url?.origin === ORIGIN && !url.pathname.startsWith('//') ? url.pathname + url.search + url.hash : '/pulls'
}
