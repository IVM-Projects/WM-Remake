// Catalogue d'affichage (G6), sans server-only : la boutique l'importe côté client. Les montants facturés sont ceux des Prices Stripe.
export const SHOP = {
  pro_monthly: { label: 'Abonnement Pro', mode: 'subscription', cents: 999, currency: 'CAD', interval: 'month', priceEnv: 'STRIPE_PRICE_PRO_MONTHLY' },
  wb_2500: { label: '2 500 wikibidous', mode: 'payment', cents: 499, currency: 'CAD', wb: 2500, priceEnv: 'STRIPE_PRICE_WB_2500' },
} as const

export type ShopItem = keyof typeof SHOP

export function formatPrice(cents: number): string {
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'code' }).format(cents / 100)
}

type FreePro = { free: number; pro: number }

// Réponse de wm.shop_state (G34, G46).
export type ShopState = {
  rules: {
    pack_size: number
    pack_period_s: FreePro
    pro_daily_size: number
    max_concurrent_auctions: FreePro
    battle_quota: FreePro
    sales_detail_days: number
    wb_2500: number
  }
  me: {
    balance: number
    is_pro: boolean
    is_vip: boolean
    pack_cap: number
    has_customer: boolean
    subscription: { status: string; current_period_end: string | null; cancel_at_period_end: boolean; cancel_at: string | null } | null
  }
  purchase: { item: ShopItem; created_at: string } | null
  maintenance: boolean
}
