import 'server-only'
import { createHash } from 'node:crypto'
import Stripe from 'stripe'
import type { RpcResult } from '@/lib/route'
import { SHOP, type ShopItem } from '@/lib/shop'
import { createAdminClient } from '@/lib/supabase/admin'

// Épinglée (G2) : le type de l'option n'accepte que la version du SDK installé, un autre SDK casse le typecheck.
export const STRIPE_API_VERSION = '2026-10-28.endive'

// STRIPE_API_URL (G36, facultative) : le SDK prend host, port et protocol séparés ; HTTP clair seulement pour protocol === 'http'.
// null pour une URL illisible ou un autre schéma que http:/https:. Sans port, celui du schéma (le SDK prendrait 443 même en http).
export function apiTarget(url: string): { host: string; port: string; protocol: 'http' | 'https' } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return { host: u.hostname, port: u.port || (u.protocol === 'http:' ? '80' : '443'), protocol: u.protocol === 'http:' ? 'http' : 'https' }
}

let liveKeyLogged = false

// Variables lues à l'appel (G32) ; la clé n'est jamais journalisée ni recopiée dans une erreur, l'URL non plus.
// Mode test seulement (D:24) : stripe_apply ignore tout événement livemode, une clé live prendrait de l'argent sans rien créditer ; toute
// clé hors sk_test_/rk_test_ → aucun client (503 stripe_disabled, résiliation en attente), journalisé une fois. Le passage en live lève
// cette garde en même temps que celle de stripe_apply. STRIPE_API_URL illisible → aucun client, jamais un repli vers api.stripe.com.
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  if (!/^(sk|rk)_test_/.test(key)) {
    if (!liveKeyLogged) console.error(JSON.stringify({ stripe: 'live_key_refused' }))
    liveKeyLogged = true
    return null
  }
  const url = process.env.STRIPE_API_URL
  let target = {}
  if (url) {
    const t = apiTarget(url)
    if (!t) {
      console.error(JSON.stringify({ stripe: 'bad_api_url' }))
      return null
    }
    target = t
  }
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 1, timeout: 10_000, ...target })
}

// Erreur au format de wm.raise_err, lue par toHttpError comme une erreur SQL.
export const stripeFail = (status: number, code: string, message: string): RpcResult =>
  ({ data: null, error: { code: 'P0001', message, details: JSON.stringify({ status, code, error: message, message }) } })

const disabled = () => stripeFail(503, 'stripe_disabled', 'Paiement non configuré.')
const unavailable = () => stripeFail(502, 'stripe_unavailable', 'Le paiement est indisponible, réessaie dans un instant.')
const wm = () => createAdminClient().schema('wm')

// Appel du SDK : toute erreur devient null et une ligne sans détail (le message de Stripe peut porter l'e-mail).
async function sdk<T>(op: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call()
  } catch {
    console.error(JSON.stringify({ stripe: 'api_failed', op }))
    return null
  }
}

export const TOS_MESSAGE = (origin: string): string =>
  `J'accepte les [conditions d'utilisation](${origin}/terms) et je demande l'accès immédiat au contenu numérique acheté : je renonce ainsi à mon droit de rétractation.`

// Session Checkout hébergée (G17, G31) ; success_url n'accorde rien, le webhook crédite (G33).
export function checkoutParams(a: { uid: string; item: ShopItem; customer: string; price: string; origin: string }): Stripe.Checkout.SessionCreateParams {
  const { uid, item } = a
  return {
    mode: SHOP[item].mode,
    customer: a.customer,
    client_reference_id: uid,
    metadata: { uid, item },
    line_items: [{ price: a.price, quantity: 1 }],
    locale: 'fr',
    consent_collection: { terms_of_service: 'required' },
    custom_text: { terms_of_service_acceptance: { message: TOS_MESSAGE(a.origin) } },
    success_url: `${a.origin}/pulls?shop=success&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${a.origin}/pulls?shop=cancel`,
    ...(item === 'pro_monthly' ? { subscription_data: { metadata: { uid } } } : { payment_intent_data: { metadata: { uid, item } } }),
  }
}

// `call` de route() pour POST /api/stripe/checkout.
export function checkoutCall(origin: string): (args: Record<string, unknown>) => Promise<RpcResult> {
  return async (args) => {
    const uid = args.p_uid as string
    const item = args.p_item as ShopItem
    // Jamais args tels quels : route() y ajoute p_idem, que la fonction n'a pas (PGRST202).
    const prep = await wm().rpc('stripe_checkout_prepare', { p_uid: uid, p_item: item })
    if (prep.error) return prep
    const stripe = stripeClient()
    const price = process.env[SHOP[item].priceEnv]
    if (!stripe || !price) return disabled()
    const { customer_id, email } = prep.data as { customer_id: string | null; email: string | null }
    let customer = customer_id
    if (!customer) {
      // G45 : un e-mail changé entre deux essais donne une autre clé.
      const hash = createHash('sha256').update(email ?? '').digest('hex').slice(0, 16)
      const created = await sdk('checkout', () =>
        stripe.customers.create({ email: email ?? undefined, metadata: { uid } }, { idempotencyKey: `customer:${uid}:${hash}` }))
      if (!created) return unavailable()
      const set = await wm().rpc('stripe_customer_set', { p_uid: uid, p_customer_id: created.id })
      if (set.error) return set
      // null : ce Customer appartient déjà à un autre joueur ; jamais lu comme « pas de Customer ».
      if (typeof set.data !== 'string') {
        console.error(JSON.stringify({ stripe: 'customer_taken', op: 'checkout' }))
        return unavailable()
      }
      customer = set.data
    }
    const idem = typeof args.p_idem === 'string' && args.p_idem ? `checkout:${uid}:${item}:${args.p_idem}` : undefined
    const session = await sdk('checkout', () =>
      stripe.checkout.sessions.create(checkoutParams({ uid, item, customer, price, origin }), { idempotencyKey: idem }))
    // Une session sans url (jamais pour un Checkout hébergé) serait un 200 inutilisable.
    return session?.url ? { data: { url: session.url }, error: null } : unavailable()
  }
}

// `call` de route() pour POST /api/stripe/portal.
export function portalCall(origin: string): (args: Record<string, unknown>) => Promise<RpcResult> {
  return async (args) => {
    const prep = await wm().rpc('stripe_portal_prepare', { p_uid: args.p_uid })
    if (prep.error) return prep
    const stripe = stripeClient()
    if (!stripe) return disabled()
    const { customer_id } = prep.data as { customer_id: string }
    const session = await sdk('portal', () =>
      stripe.billingPortal.sessions.create({ customer: customer_id, return_url: `${origin}/settings`, locale: 'fr' }))
    return session?.url ? { data: { url: session.url }, error: null } : unavailable()
  }
}

// Résiliation immédiate, sans remboursement (G10) ; un abonnement déjà absent chez Stripe compte comme résilié.
export async function cancelSubscription(id: string, stripe = stripeClient()): Promise<boolean> {
  if (!stripe) return false
  try {
    await stripe.subscriptions.cancel(id)
    return true
  } catch (e) {
    if (e instanceof Stripe.errors.StripeInvalidRequestError && e.code === 'resource_missing') return true
    console.error(JSON.stringify({ stripe: 'api_failed', op: 'cancel' }))
    return false
  }
}

// Suppression de compte et « Résilier » du staff (G10, G35) : true seulement si plus rien n'est en attente. Sans abonnement, Stripe
// n'est jamais appelé (G32).
export async function cancelSubscriptionsFor(userId: string): Promise<boolean> {
  const targets = await wm().rpc('stripe_cancel_targets', { p_user_id: userId })
  if (targets.error) return false
  const ids = (targets.data as { subscription_ids: string[] }).subscription_ids
  if (ids.length === 0) return true
  const stripe = stripeClient()
  if (!stripe) return false
  const results = await Promise.all(ids.map((id) => cancelSubscription(id, stripe)))
  if (results.includes(false)) return false
  const done = await wm().rpc('stripe_cancel_done', { p_user_id: userId, p_subscription_ids: ids })
  // Un abonnement né pendant les appels garde le drapeau (G35).
  return !done.error && !(done.data as { stripe_pending: boolean }).stripe_pending
}

// Webhook (G14) : vérification statique, aucune clé d'API ; tolérance 300 s.
export function verifyEvent(body: string, signature: string | null, secret: string): Stripe.Event {
  return Stripe.webhooks.constructEvent(body, signature ?? '', secret, 300)
}
