import Stripe from 'stripe'
import { reply } from '@/lib/cron'
import { fail, INTERNAL, toHttpError } from '@/lib/route'
import { verifyEvent } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'

type Log = { pg_code: string | null; event_type: string | null; event_id: string | null; duplicate: boolean | null; outcome: string | null }

const str = (v: unknown) => (typeof v === 'string' ? v : null)

// G14, G32 : le corps brut n'est lu qu'en texte et n'est jamais parsé avant la signature ; sans signature valide, aucune RPC.
async function handle(req: Request, log: Log): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return reply(fail(503, 'Paiement non configuré.', 'stripe_disabled'))
  const body = await req.text()
  let event: unknown
  try {
    event = verifyEvent(body, req.headers.get('stripe-signature'), secret)
  } catch (err) {
    // Signature bonne mais corps illisible (pas du JSON, événement v2 « thin ») : même 400, consigné à part, sans le message.
    if (!(err instanceof Stripe.errors.StripeSignatureVerificationError)) log.event_type = 'unparsable'
    return reply(fail(400, 'Signature Stripe invalide', 'invalid_signature'))
  }
  // Signé mais quelconque (null, sans type) : stripe_apply le refuse en 400, jamais une exception ici.
  const e = event && typeof event === 'object' ? (event as Record<string, unknown>) : {}
  log.event_type = str(e.type)
  log.event_id = str(e.id)
  // Une transaction : dédoublonnage (stripe_events) et effet ensemble ; une erreur annule les deux et Stripe réessaie (D:330).
  const { data, error } = await createAdminClient().schema('wm').rpc('stripe_apply', { p_event: event })
  if (error) {
    log.pg_code = error.code ?? null
    // P0001 400/503 recopiés (maintenance : Stripe réessaie), BUSY_CODES → 503, tout le reste → 500 : Stripe réessaie aussi.
    return reply(toHttpError(error))
  }
  // Réponse inattendue : l'événement est appliqué (la transaction a validé), jamais un 500 que Stripe rejouerait sans fin.
  const applied = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  log.duplicate = applied?.duplicate === true
  log.outcome = applied ? str(applied.outcome) : 'unknown'
  return Response.json({ received: true })
}

// Hors route() : Stripe n'est pas un joueur (aucun cookie, aucune Origin) ; exempté de la porte (lib/gate.ts, G37). Runtime Node par défaut.
export async function POST(req: Request): Promise<Response> {
  const t0 = performance.now()
  const log: Log = { pg_code: null, event_type: null, event_id: null, duplicate: null, outcome: null }
  let res: Response
  try {
    res = await handle(req, log)
  } catch {
    // Jamais le message : il peut porter un détail de la base ou de la requête.
    log.pg_code = 'thrown'
    res = reply(fail(500, INTERNAL))
  }
  // Ni corps, ni en-tête de signature, ni secret, ni joueur : l'événement par son id et son type seulement.
  console.log(JSON.stringify({
    route: '/api/stripe/webhook', status: res.status, ms: Math.round(performance.now() - t0), rpc: 'stripe_apply', pg_code: log.pg_code,
    event_type: log.event_type, event_id: log.event_id, duplicate: log.duplicate, outcome: log.outcome, vercel_id: req.headers.get('x-vercel-id'),
  }))
  return res
}
