import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { resolveTz } from '@/lib/tz'

z.config(z.locales.fr())

export const UNAUTHORIZED = 'Session expirée, reconnecte-toi.'
export const BUSY = 'Le site est très sollicité, réessaie dans un instant.'
export const INTERNAL = 'Erreur interne, réessaie dans un instant.'

export type RouteCtx = { uid: string | null; tz: string; idem: string | null; params: Record<string, string> }
type HttpError = { status: number; body: Record<string, unknown>; retryAfter?: number }

const fail = (status: number, message: string, code?: string): HttpError =>
  ({ status, body: { ...(code && { code }), error: message, message } })

function parseDetail(details: string | null | undefined): Record<string, unknown> | null {
  try {
    const d: unknown = JSON.parse(details ?? '')
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Seul le détail JSON de wm.raise_err (P0001) est recopié ; tout le reste devient un 500 sans rien de Postgres.
export function toHttpError(err: { code?: string; message?: string; details?: string | null }): HttpError {
  if (err.code === '55P03' || err.code === '57014') return { ...fail(503, BUSY, 'BUSY'), retryAfter: 1 }
  const detail = err.code === 'P0001' ? parseDetail(err.details) : null
  const { status, ...body } = detail ?? {}
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return fail(500, INTERNAL)
  if (status !== 429 && status !== 503) return { status, body }
  const after = Number(body.retry_after)
  return { status, body, retryAfter: Number.isFinite(after) && after > 0 ? Math.ceil(after) : 1 }
}

async function readInput(req: NextRequest): Promise<unknown> {
  const query = () => Object.fromEntries(req.nextUrl.searchParams)
  if (req.method === 'GET') return query()
  const text = await req.text()
  return req.method === 'DELETE' && text === '' ? query() : JSON.parse(text)
}

type Outcome = { status: number; body: unknown; retryAfter?: number; pgCode?: string }

export function route<I = undefined>(opts: {
  fn: string
  auth?: boolean
  input?: z.ZodType<I>
  args?: (input: I, ctx: RouteCtx) => Record<string, unknown>
}): (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> {
  const auth = opts.auth ?? true

  async function run(req: NextRequest, ctx: RouteCtx): Promise<Outcome> {
    if (auth) {
      const { data } = await (await createClient()).auth.getClaims()
      ctx.uid = data?.claims.sub ?? null
      if (!ctx.uid) return fail(401, UNAUTHORIZED, 'unauthorized')
    }
    if (ctx.idem !== null && (ctx.idem.length < 1 || ctx.idem.length > 128)) {
      return fail(400, 'Idempotency-Key invalide (1 à 128 caractères).', 'invalid_request')
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
    const args = opts.args ? opts.args(input, ctx) : auth ? { p_uid: ctx.uid } : {}
    const { data, error } = await createAdminClient().schema('wm').rpc(opts.fn, args)
    if (error) return { ...toHttpError(error), pgCode: error.code }
    return { status: 200, body: data ?? null }
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
    console.log(JSON.stringify({
      // Segments dynamiques masqués (`/api/profile/[id]`) : un id ou un pseudo dans le chemin serait de la PII.
      route: Object.entries(ctx.params).reduce((p, [k, v]) => p.replace(`/${encodeURIComponent(v)}`, `/[${k}]`), req.nextUrl.pathname),
      status: out.status,
      ms: Math.round(performance.now() - t0),
      rpc: opts.fn,
      pg_code: out.pgCode ?? null,
      uid_hash: ctx.uid && createHash('sha256').update(ctx.uid).digest('hex').slice(0, 12),
      vercel_id: req.headers.get('x-vercel-id'),
    }))
    const headers = out.retryAfter ? { 'Retry-After': String(out.retryAfter) } : undefined
    return Response.json(out.body, { status: out.status, headers })
  }
}
