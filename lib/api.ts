import { noteServerDate } from './clock'

// Erreur d'une route /api : statut et corps JSON tels quels ({code?, error, message} pour nos routes).
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown) {
    const b = body as { error?: unknown; message?: unknown } | null
    super(String(b?.error ?? b?.message ?? `Erreur ${status}`))
    this.status = status
    this.body = body
  }
}

// randomUUID n'existe qu'en contexte sécurisé (HTTPS, localhost) : en HTTP sur le réseau local, 128 bits de getRandomValues en hex.
export const idemKey = (): string =>
  crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

// Jour calendaire du joueur (paquet Pro du jour, plafond quotidien) : en-tête lu par les routes (R§3.0).
export const calendarTz = (): Record<string, string> => ({ 'x-wiki-calendar-tz': Intl.DateTimeFormat().resolvedOptions().timeZone })

// Client des routes /api depuis le navigateur ; `idem` pose une Idempotency-Key, neuve (true) ou donnée (rejouer = même réponse côté serveur).
export async function api<T>(path: string, init: RequestInit & { idem?: boolean | string } = {}): Promise<T> {
  const { idem, ...rest } = init
  const headers = new Headers(rest.headers)
  if (idem) headers.set('Idempotency-Key', idem === true ? idemKey() : idem)
  if (typeof rest.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...rest, headers })
  noteServerDate(res)
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

// Échec sans verdict du serveur (réseau, ≥ 500, page d'erreur de la plateforme) : l'action a pu avoir lieu.
export const unsure = (e: unknown): boolean => !(e instanceof ApiError) || e.status >= 500

// Texte pour l'écran : nos routes répondent en français sous 500 ; réseau, ≥ 500 ou corps non JSON → le repli.
export function userMessage(e: unknown, fallback: string): string {
  const b = e instanceof ApiError && e.status < 500 ? (e.body as { error?: unknown; message?: unknown } | null) : null
  return typeof (b?.error ?? b?.message) === 'string' ? (e as ApiError).message : fallback
}

// Une Idempotency-Key par intention (design C6) : gardée dans `keys` tant que l'issue est inconnue, la relance rejoue
// la réponse stockée au lieu d'agir deux fois ; oubliée dès que le serveur a tranché (2xx ou 4xx).
export async function apiOnce<T>(keys: Map<string, string>, intent: string, path: string, init: RequestInit = {}): Promise<T> {
  const idem = keys.get(intent) ?? idemKey()
  keys.set(intent, idem)
  try {
    const body = await api<T>(path, { ...init, idem })
    keys.delete(intent)
    return body
  } catch (e) {
    if (!unsure(e)) keys.delete(intent)
    throw e
  }
}
