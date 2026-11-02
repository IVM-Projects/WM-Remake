import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHOP, formatPrice } from '@/lib/shop'

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

  it('aucune promesse de meilleures cotes (D:102)', () => {
    expect(readFileSync('lib/shop.ts', 'utf8')).not.toMatch(/meilleur|cote/i)
  })
})
