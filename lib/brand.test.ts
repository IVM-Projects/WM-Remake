import { describe, it, expect } from 'vitest'
import { normalizeBrand, assertBrandSafe, BRAND_DEFAULT, pageTitle, splitBrand } from '@/lib/brand'

describe('marque', () => {
  it.each(['WikiMasters', 'Wiki Masters', 'WIKI-MASTERS', 'WikiMastérs', ' wikimasters '])(
    'refuse %j sans porte', (n) => {
      expect(normalizeBrand(n)).toBe('wikimasters')
      expect(() => assertBrandSafe(n, undefined)).toThrow(/DEMO_GATE_PASSWORD/)
      expect(() => assertBrandSafe(n, '')).toThrow(/DEMO_GATE_PASSWORD/)
    })
  it('accepte la marque d\'origine derrière la porte', () => {
    expect(() => assertBrandSafe('WikiMasters', 's3cret')).not.toThrow()
  })
  it('accepte une autre marque sans porte', () => {
    expect(() => assertBrandSafe(BRAND_DEFAULT, undefined)).not.toThrow()
  })
  it('découpe le préfixe Wiki pour le logo', () => {
    expect(splitBrand('WikiCartes')).toEqual({ name: 'WikiCartes', prefix: 'Wiki', rest: 'Cartes' })
    expect(splitBrand('Encyclodeck')).toEqual({ name: 'Encyclodeck', prefix: null, rest: 'Encyclodeck' })
  })
  it('titre de page', () => {
    expect(pageTitle('Connexion')).toBe(`Connexion — ${BRAND_DEFAULT}`)
  })
})
