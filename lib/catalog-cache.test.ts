import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
const cacheTag = vi.fn()
const cacheLife = vi.fn()
vi.mock('next/cache', () => ({ cacheTag, cacheLife }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ schema: () => ({ rpc }) }) }))

const { cardsCall, normalizeQ, sharedCardsPage } = await import('@/lib/catalog-cache')

const shared = { total: 2, rarityCounts: { L: 2 }, cards: [{ id: 'a' }, { id: 'b' }] }
const overlay = { ownedCardIds: ['a'], wishlistCardIds: [], friendOwners: {} }
// Erreur de supabase-js : une instance d'Error, que le cache ne sérialiserait pas telle quelle.
const pgError = (code: string) =>
  Object.assign(new Error('La recherche demande au moins 2 caractères'), { code, details: '{"status":400}', hint: null })

beforeEach(() => {
  vi.clearAllMocks()
  rpc.mockImplementation(async (fn: string) => ({ data: fn === 'cards_overlay' ? overlay : shared, error: null }))
})

describe('cardsCall', () => {
  it('page partagée sous la clé normalisée (q, raretés triées sans doublon), puis overlay des ids de la page, fusionnés', async () => {
    const out = await cardsCall({ p_page: 0, p_q: '  ChAt ', p_rarity: ['UR', 'L', 'UR'], p_uid: 'u' })
    expect(rpc.mock.calls).toStrictEqual([
      ['cards_page_shared', { p_page: 0, p_sort: 'rarity', p_q: 'chat', p_rarity: ['L', 'UR'] }],
      ['cards_overlay', { p_uid: 'u', p_card_ids: ['a', 'b'] }],
    ])
    expect(out).toStrictEqual({ data: { ...shared, ...overlay }, error: null })
    expect(cacheTag).toHaveBeenCalledWith('catalog')
    expect(cacheLife).toHaveBeenCalledWith('hours')
  })

  it.each(['p_wishlist', 'p_missing'])('%s → cards_page seul, avec les mêmes arguments', async (key) => {
    const args = { p_page: 1, p_q: 'Chat', [key]: true, p_uid: 'u' }
    await cardsCall(args)
    expect(rpc.mock.calls).toStrictEqual([['cards_page', args]])
  })

  it('P0001 de la page partagée → rendue en objet simple (code, message, details), jamais levée, sans overlay', async () => {
    rpc.mockResolvedValue({ data: null, error: pgError('P0001') })
    const error = { code: 'P0001', message: 'La recherche demande au moins 2 caractères', details: '{"status":400}' }
    expect(await sharedCardsPage(0, 'rarity', 'a', null)).toStrictEqual({ data: null, error })
    expect(await cardsCall({ p_page: 0, p_q: 'a', p_uid: 'u' })).toStrictEqual({ data: null, error })
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain('cards_overlay')
  })

  it('autre erreur de la page partagée (08006) → une ligne de log avec pg_code, puis levée', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockResolvedValue({ data: null, error: pgError('08006') })
    await expect(sharedCardsPage(0, 'rarity', null, null)).rejects.toThrow()
    expect(log.mock.calls).toStrictEqual([[JSON.stringify({ rpc: 'cards_page_shared', pg_code: '08006' })]])
    log.mockRestore()
  })
})

describe('normalizeQ', () => {
  it('trim et minuscules seulement ; vide → null', () => {
    expect(normalizeQ('   ')).toBeNull()
    expect(normalizeQ(undefined)).toBeNull()
    // Accents et espaces intérieurs gardés : 2 caractères comparés tels quels, 3+ passent par unaccent en SQL.
    expect(normalizeQ(' Été  Indien ')).toBe('été  indien')
  })
})
