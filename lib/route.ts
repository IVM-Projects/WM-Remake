import { createHash } from 'node:crypto'
import { after, type NextRequest } from 'next/server'
import { z } from 'zod'
import { accessDenied } from '@/lib/access'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { resolveTz } from '@/lib/tz'

z.config(z.locales.fr())

export const UNAUTHORIZED = 'Session expirée, reconnecte-toi.'
export const BUSY = 'Le site est très sollicité, réessaie dans un instant.'
export const INTERNAL = 'Erreur interne, réessaie dans un instant.'

export type RouteCtx = { uid: string | null; tz: string; idem: string | null; params: Record<string, string> }
export type HttpError = { status: number; body: Record<string, unknown>; retryAfter?: number }
export type RpcResult = { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }

// Corps D§8.2 ; aussi pour les hooks `pre`.
export const fail = (status: number, message: string, code?: string): HttpError =>
  ({ status, body: { ...(code && { code }), error: message, message } })

function parseDetail(details: string | null | undefined): Record<string, unknown> | null {
  try {
    const d: unknown = JSON.parse(details ?? '')
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Verrou, délai, interblocage (P29), PostgREST sans connexion ou pool saturé : 503 BUSY ; aussi rendus par lib/market-cache.ts (P10).
export const BUSY_CODES = new Set(['55P03', '57014', '40P01', 'PGRST000', 'PGRST003'])

// Seul le détail JSON de wm.raise_err (P0001) est recopié ; tout le reste devient un 500 sans rien de Postgres.
export function toHttpError(err: { code?: string; message?: string; details?: string | null }): HttpError {
  if (BUSY_CODES.has(err.code ?? '')) return { ...fail(503, BUSY, 'BUSY'), retryAfter: 1 }
  const detail = err.code === 'P0001' ? parseDetail(err.details) : null
  const { status, ...body } = detail ?? {}
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return fail(500, INTERNAL)
  if (status !== 429 && status !== 503) return { status, body }
  // Un retry_after non numérique est une échéance ISO (ex. next_regen_at) : on la convertit en secondes restantes.
  const n = Number(body.retry_after)
  const after = Number.isNaN(n) ? (Date.parse(String(body.retry_after)) - Date.now()) / 1000 : n
  return { status, body, retryAfter: Number.isFinite(after) && after > 0 ? Math.ceil(after) : 1 }
}

async function readInput(req: NextRequest): Promise<unknown> {
  const q = req.nextUrl.searchParams
  // Une clé répétée (rarity=L&rarity=UR) devient un tableau, une clé unique reste une chaîne.
  const query = () => Object.fromEntries(Array.from(new Set(q.keys()), (k) => [k, q.getAll(k).length > 1 ? q.getAll(k) : q.get(k)]))
  // HEAD : Next le sert par le handler GET, donc même entrée.
  if (req.method === 'GET' || req.method === 'HEAD') return query()
  const text = await req.text()
  if (text === '') return req.method === 'DELETE' ? query() : {}
  return JSON.parse(text)
}

// Segments dynamiques masqués (`/api/profile/[id]`) : un id ou un pseudo dans le chemin serait de la PII.
// Comparaison par segment entier décodé ; une valeur retrouvée nulle part (encodage inattendu) → null, jamais le chemin brut.
export function maskPath(pathname: string, params: Record<string, string>): string | null {
  const names = new Map(Object.entries(params).map(([k, v]) => [v, k]))
  const found = new Set<string>()
  const path = pathname.split('/').map((segment) => {
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return segment
    }
    const name = names.get(value)
    if (name === undefined) return segment
    found.add(value)
    return `[${name}]`
  }).join('/')
  return found.size === names.size ? path : null
}

type Outcome = { status: number; body: unknown; retryAfter?: number; pgCode?: string }

export function route<I = undefined, P = Record<string, string>>(opts: {
  fn: string
  auth?: boolean
  input?: z.ZodType<I>
  params?: z.ZodType<P>
  idem?: boolean
  pre?: (input: I, req: NextRequest) => Promise<HttpError | void>
  args?: (input: I, ctx: RouteCtx & { params: P }) => Record<string, unknown>
  // Remplace la RPC (cache de /api/cards) ; `fn` reste le nom journalisé.
  call?: (args: Record<string, unknown>) => Promise<RpcResult>
  // Statut d'un succès (201 pour une création), 200 par défaut.
  status?: number
  // Posés sur un succès seulement.
  headers?: Record<string, string>
  // RPC qui insère des notifications (B6) : drain de l'outbox après la réponse d'un succès ; lib/push chargé seulement alors.
  push?: boolean
}): (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> {
  const auth = opts.auth ?? true
  const ok = opts.status ?? 200

  async function run(req: NextRequest, ctx: RouteCtx): Promise<Outcome> {
    if (auth) {
      const { data } = await (await createClient()).auth.getClaims()
      ctx.uid = data?.claims.sub ?? null
      if (!ctx.uid) return fail(401, UNAUTHORIZED, 'unauthorized')
      // Lectures seulement : les écritures passent par wm.actor (G4).
      if (req.method === 'GET' || req.method === 'HEAD') {
        const denied = await accessDenied(ctx.uid)
        if (denied) return denied
      }
    }
    if (ctx.idem !== null && (ctx.idem.length < 1 || ctx.idem.length > 128)) {
      return fail(400, 'Idempotency-Key invalide (1 à 128 caractères).', 'invalid_request')
    }
    let params = ctx.params as P
    if (opts.params) {
      const parsed = opts.params.safeParse(ctx.params)
      if (!parsed.success) return fail(400, parsed.error.issues[0].message, 'invalid_request')
      params = parsed.data
    }
    let input = undefined as I
    if (opts.input) {
      let raw: unknown
      try {
        raw = await readInput(req)
      } catch {
        return fail(400, 'Corps JSON invalide', 'invalid_request')
      }
      const parsed = opts.input.safeParse(raw)
      if (!parsed.success) return fail(400, parsed.error.issues[0].message, 'invalid_request')
      input = parsed.data
    }
    const denied = await opts.pre?.(input, req)
    if (denied) return denied
    // p_uid posé en dernier : un handler ne peut pas le remplacer par un uid venu du client.
    const args = {
      ...opts.args?.(input, { ...ctx, params } as RouteCtx & { params: P }),
      ...(opts.idem && { p_idem: ctx.idem }),
      ...(auth && { p_uid: ctx.uid }),
    }
    const { data, error } = opts.call ? await opts.call(args) : await createAdminClient().schema('wm').rpc(opts.fn, args)
    if (error) return { ...toHttpError(error), pgCode: error.code }
    return { status: ok, body: data ?? null }
  }

  return async (req, { params }) => {
    const t0 = performance.now()
    // Lire les en-têtes d'abord : avec cacheComponents, c'est ce qui exclut la route du prérendu.
    const ctx: RouteCtx = {
      uid: null,
      tz: resolveTz(req.headers.get('x-wiki-calendar-tz')),
      idem: req.headers.get('idempotency-key'),
      params: (await params) ?? {},
    }
    let out: Outcome
    try {
      out = await run(req, ctx)
    } catch {
      out = fail(500, INTERNAL)
    }
    if (opts.push && out.status === ok) {
      after(async () => {
        try {
          await (await import('@/lib/push')).drainPush()
        } catch {
          console.error(JSON.stringify({ push: 'drain_failed' }))
        }
      })
    }
    console.log(JSON.stringify({
      route: maskPath(req.nextUrl.pathname, ctx.params),
      status: out.status,
      ms: Math.round(performance.now() - t0),
      rpc: opts.fn,
      pg_code: out.pgCode ?? null,
      uid_hash: ctx.uid && createHash('sha256').update(ctx.uid).digest('hex').slice(0, 12),
      vercel_id: req.headers.get('x-vercel-id'),
    }))
    // 429/503 sans échéance connue (un `pre` compris) : Retry-After: 1 quand même, les clients l'attendent.
    const retryAfter = out.retryAfter || (out.status === 429 || out.status === 503 ? 1 : undefined)
    const headers = retryAfter ? { 'Retry-After': String(retryAfter) } : out.status === ok ? opts.headers : undefined
    return Response.json(out.body, { status: out.status, headers })
  }
}
