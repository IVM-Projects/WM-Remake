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

// Client des routes /api depuis le navigateur ; `idem` pose une Idempotency-Key neuve (rejouer = même réponse côté serveur).
export async function api<T>(path: string, init: RequestInit & { idem?: boolean } = {}): Promise<T> {
  const { idem, ...rest } = init
  const headers = new Headers(rest.headers)
  if (idem) headers.set('Idempotency-Key', crypto.randomUUID())
  if (typeof rest.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...rest, headers })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}
