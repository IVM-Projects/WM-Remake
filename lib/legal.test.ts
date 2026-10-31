import { describe, expect, it, vi } from 'vitest'

// server-only lève hors de la condition react-server, et lib/legal.ts l'importe lui-même.
vi.mock('server-only', () => ({}))
const { legalInfo, MISSING } = await import('@/lib/legal')

describe('legalInfo', () => {
  it('met « à compléter » partout sans variable', () => {
    expect(legalInfo({})).toEqual({ publisher: MISSING, address: MISSING, director: MISSING, contact: MISSING, host: MISSING })
    expect(MISSING).toBe('à compléter')
  })
  it('rogne les valeurs', () => {
    expect(legalInfo({ LEGAL_PUBLISHER: '  Éditeur  ' }).publisher).toBe('Éditeur')
  })
  it('traite une valeur blanche comme absente', () => {
    expect(legalInfo({ LEGAL_CONTACT: '   ' }).contact).toBe('à compléter')
  })
})
