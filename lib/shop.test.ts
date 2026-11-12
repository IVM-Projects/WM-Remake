import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHOP, formatPrice, liveSubscription, stripeUrl } from '@/lib/shop'

describe('lib/shop', () => {
  it('formatPrice : montant en CAD au format fr-CA (espaces fines comprises, lues d\'Intl)', () => {
    const intl = (n: number) => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'code' }).format(n)
    expect(formatPrice(999)).toBe(intl(9.99))
    expect(formatPrice(499)).toBe(intl(4.99))
    expect(formatPrice(999).replace(/\s/g, ' ')).toBe('9,99 CAD')
    expect(formatPrice(499).replace(/\s/g, ' ')).toBe('4,99 CAD')
  })

  it('catalogue : 2 500 WB à 4,99, Pro à 9,99 par mois', () => {
    expect(SHOP.wb_2500.wb).toBe(2500)
    expect(SHOP.wb_2500.cents).toBe(499)
    expect(SHOP.pro_monthly).toMatchObject({ mode: 'subscription', cents: 999, interval: 'month' })
  })

  it('stripeUrl : seules les pages https de Checkout et du Portail passent (jamais un autre hôte, port, schéma ou sous-domaine piégé)', () => {
    expect(stripeUrl({ url: 'https://checkout.stripe.com/c/pay/cs_test_x' })).toBe('https://checkout.stripe.com/c/pay/cs_test_x')
    expect(stripeUrl({ url: 'https://billing.stripe.com/p/session/x' })).toBe('https://billing.stripe.com/p/session/x')
    for (const url of ['http://billing.stripe.com/p', 'https://billing.stripe.com.evil.example/p', 'https://evil.example/https://billing.stripe.com',
      'https://user@evil.example/', 'javascript:alert(1)', 'https://stripe.com/', '/relative', '', null, undefined, 42]) {
      expect(stripeUrl({ url }), String(url)).toBeNull()
    }
    expect(stripeUrl(null)).toBeNull()
  })

  it('liveSubscription : tout statut sauf canceled et incomplete_expired, rien sans statut lisible', () => {
    for (const status of ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused']) expect(liveSubscription({ status }), status).toBe(true)
    for (const s of [{ status: 'canceled' }, { status: 'incomplete_expired' }, {}, { status: 7 }, null, undefined]) expect(liveSubscription(s)).toBe(false)
  })

  it('aucune promesse de meilleures cotes (D:102)', () => {
    expect(readFileSync(fileURLToPath(new URL('./shop.ts', import.meta.url)), 'utf8')).not.toMatch(/meilleur|cote/i)
  })
})
