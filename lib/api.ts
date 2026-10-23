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
// Nos 503 codés (BUSY…) y tombent aussi : clé gardée et relectures sans danger, le serveur a tout annulé (texte : userMessage).
export const unsure = (e: unknown): boolean => !(e instanceof ApiError) || e.status >= 500

// Texte de l'issue incertaine d'une écriture (B12, P19) ; repli connu : « L'action n'a pas abouti. ».
export const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'

// Texte pour l'écran : nos routes répondent en français ; ≥ 500, seulement avec leur code (BUSY, maintenance, catalog_empty :
// refus net, tout annulé côté serveur). Réseau, 500 interne sans code ou corps non JSON → le repli.
export function userMessage(e: unknown, fallback: string): string {
  const b = e instanceof ApiError ? (e.body as { code?: unknown; error?: unknown; message?: unknown } | null) : null
  const ours = e instanceof ApiError && (e.status < 500 || typeof b?.code === 'string')
  return ours && typeof (b?.error ?? b?.message) === 'string' ? (e as ApiError).message : fallback
}

// Une Idempotency-Key par intention (design C6) : gardée dans `keys` tant que l'issue est inconnue, la relance rejoue
// la réponse stockée au lieu d'agir deux fois ; oubliée dès qu'une réponse du serveur est lue (2xx au corps lisible, ou 4xx).
// Un 2xx au corps illisible (connexion coupée après les en-têtes) rend null et garde la clé : l'appelant échoue sur null, la relance rejoue.
// shortcut: un 200 null légitime garderait aussi la clé ; les routes passées à apiOnce renvoient toutes un objet, à revoir si l'une renvoie null.
export async function apiOnce<T>(keys: Map<string, string>, intent: string, path: string, init: RequestInit = {}): Promise<T> {
  const idem = keys.get(intent) ?? idemKey()
  keys.set(intent, idem)
  try {
    const body = await api<T>(path, { ...init, idem })
    if (body !== null) keys.delete(intent)
    return body
  } catch (e) {
    if (!unsure(e)) keys.delete(intent)
    throw e
  }
}
