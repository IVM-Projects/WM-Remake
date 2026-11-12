// Événements Stripe signés du contrat (G15) : formes de l'API 2026-10-28.endive, réduites aux champs que lit wm.stripe_apply et à ceux
// qui les situent ; chaque champ posé est vérifié contre le type du SDK (Fixture). Signés comme Stripe, par generateTestHeaderString et le
// whsec_ factice du banc. Ids neufs à chaque appel (jamais un compteur : une base de banc réutilisée garde ceux d'un run précédent).
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { SHOP, type ShopItem } from '../lib/shop.ts'
import { STRIPE } from './harness.ts'

type Fixture<T> = T extends object ? { [K in keyof T]?: Fixture<T[K]> } : T

export const benchHex = () => randomUUID().replaceAll('-', '')
const now = () => Math.floor(Date.now() / 1000)

// Enveloppe d'un événement ; l'objet partiel ne remplit pas tout Stripe.Event, d'où la conversion.
export function event<T>(type: string, object: Fixture<T>, created = now()): Stripe.Event {
  return {
    id: `evt_bench_${benchHex()}`, object: 'event', api_version: '2026-10-28.endive', created, livemode: false, pending_webhooks: 1,
    request: { id: null, idempotency_key: null }, type, data: { object },
  } as unknown as Stripe.Event
}

export function checkoutCompleted(o: {
  uid: string; session: string; item: ShopItem; paid?: boolean; created?: number; type?: string; customer?: string
}): Stripe.Event {
  const paid = o.paid ?? true
  return event<Stripe.Checkout.Session>(o.type ?? 'checkout.session.completed', {
    id: o.session, object: 'checkout.session', mode: SHOP[o.item].mode, status: 'complete', payment_status: paid ? 'paid' : 'unpaid',
    client_reference_id: o.uid, customer: o.customer ?? `cus_bench_${benchHex()}`, metadata: { uid: o.uid, item: o.item },
    amount_total: SHOP[o.item].cents, currency: 'cad', consent: { terms_of_service: 'accepted', promotions: null }, livemode: false,
  }, o.created)
}

export function subscriptionEvent(o: {
  id: string; uid: string; status: Stripe.Subscription.Status; type: 'created' | 'updated' | 'deleted'; created: number; periodEnd: number
  cancelAtPeriodEnd?: boolean; customer?: string
}): Stripe.Event {
  const cancel = o.cancelAtPeriodEnd ?? false
  return event<Stripe.Subscription>(`customer.subscription.${o.type}`, {
    id: o.id, object: 'subscription', customer: o.customer ?? `cus_bench_${benchHex()}`, status: o.status, metadata: { uid: o.uid },
    cancel_at_period_end: cancel, cancel_at: cancel ? o.periodEnd : null, canceled_at: o.type === 'deleted' ? o.created : null,
    livemode: false,
    // Fin de période sur l'item depuis 2025-03-31.basil (G5), plus sur l'abonnement.
    items: {
      object: 'list', has_more: false, url: `/v1/subscription_items?subscription=${o.id}`,
      data: [{
        id: `si_bench_${benchHex()}`, object: 'subscription_item', subscription: o.id, quantity: 1,
        current_period_start: o.periodEnd - 30 * 86_400, current_period_end: o.periodEnd, price: { id: STRIPE.pricePro, object: 'price' },
      }],
    },
  }, o.created)
}

export function invoiceEvent(o: {
  subscription: string; uid: string; type: 'paid' | 'payment_failed'; created: number; customer?: string
}): Stripe.Event {
  return event<Stripe.Invoice>(`invoice.${o.type}`, {
    id: `in_bench_${benchHex()}`, object: 'invoice', customer: o.customer ?? `cus_bench_${benchHex()}`, created: o.created,
    status: o.type === 'paid' ? 'paid' : 'open', livemode: false,
    // Abonnement d'une facture sous parent.subscription_details depuis 2025-03-31.basil (G5).
    parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: o.subscription, metadata: { uid: o.uid } } },
  }, o.created)
}

export function disputeEvent(o: { id: string; status: Stripe.Dispute.Status; type: 'created' | 'closed'; created: number }): Stripe.Event {
  return event<Stripe.Dispute>(`charge.dispute.${o.type}`, {
    id: o.id, object: 'dispute', charge: `ch_bench_${benchHex()}`, amount: SHOP.wb_2500.cents, currency: 'cad', reason: 'fraudulent',
    status: o.status, created: o.created, livemode: false,
  }, o.created)
}

// Corps et en-tête stripe-signature (t=…,v1=…) ; `timestamp` en secondes, maintenant par défaut.
export function sign(ev: object, secret = STRIPE.webhookSecret, timestamp?: number): { payload: string; header: string } {
  const payload = JSON.stringify(ev)
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp }) }
}

// Corps brut tel quel ; `header` absent → aucun en-tête stripe-signature.
export const postRaw = (baseUrl: string, payload: string, header?: string, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/api/stripe/webhook`, {
    method: 'POST', redirect: 'manual', body: payload,
    headers: { 'content-type': 'application/json', ...(header !== undefined && { 'stripe-signature': header }), ...headers },
  })

export function signedPost(baseUrl: string, ev: object, secret = STRIPE.webhookSecret): Promise<Response> {
  const { payload, header } = sign(ev, secret)
  return postRaw(baseUrl, payload, header)
}
