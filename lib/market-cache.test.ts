import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
const cacheTag = vi.fn()
const cacheLife = vi.fn()
vi.mock('next/cache', () => ({ cacheTag, cacheLife }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ schema: () => ({ rpc }) }) }))

const { auctionCall, marketCall, salesCall } = await import('@/lib/market-cache')

const list = { total: 3, hasMore: false, auctions: [{ id: 'x', card_id: 'a' }, { id: 'y', card_id: 'b' }, { id: 'z', card_id: 'a' }] }
const detail = { auction: { id: 'x', card_id: 'a' }, bids: [] }
const shared: Record<string, unknown> = {
  market_list: list, auction_detail: detail, market_overlay: { ownedCardIds: ['a'] }, card_sales_summary: { summary: {} },
}
// Erreur de supabase-js : une instance d'Error, que le cache ne sérialiserait pas telle quelle.
const pgError = (code: string) => Object.assign(new Error('Enchère introuvable'), { code, details: '{"status":404}', hint: null })

beforeEach(() => {
  vi.clearAllMocks()
  rpc.mockImplementation(async (fn: string) => ({ data: shared[fn] ?? { fn }, error: null }))
})

describe('marketCall', () => {
  it('liste partagée sous la clé normalisée (limite bornée, tri par défaut, q, raretés triées sans doublon), puis overlay owned', async () => {
    const out = await marketCall({ p_page: 1, p_limit: 80, p_q: '  ÉlEc ', p_rarity: ['UR', 'L', 'UR'], p_uid: 'u' })
    expect(rpc.mock.calls).toStrictEqual([
      ['market_list', { p_page: 1, p_limit: 50, p_sort: 'recent', p_q: 'élec', p_rarity: ['L', 'UR'], p_card_id: null }],
      ['market_overlay', { p_uid: 'u', p_card_ids: ['a', 'b'] }],
    ])
    expect(out).toStrictEqual({ data: { ...list, auctions: [
      { id: 'x', card_id: 'a', owned: true }, { id: 'y', card_id: 'b', owned: false }, { id: 'z', card_id: 'a', owned: true },
    ] }, error: null })
    expect(cacheTag.mock.calls).toStrictEqual([['market']])
    expect(cacheLife.mock.calls).toStrictEqual([['market']])
  })

  it('p_mine → market_mine_lists seul, non caché', async () => {
    await marketCall({ p_mine: true, p_page: 2, p_uid: 'u' })
    expect(rpc.mock.calls).toStrictEqual([['market_mine_lists', { p_uid: 'u', p_page: 2 }]])
    expect(cacheLife).not.toHaveBeenCalled()
  })

  it('P0001 de la liste → cacheLife market ; code occupé → cacheLife auction ; rendus sans overlay', async () => {
    rpc.mockResolvedValue({ data: null, error: pgError('P0001') })
    expect((await marketCall({ p_page: 1, p_uid: 'u' })).error?.code).toBe('P0001')
    rpc.mockResolvedValue({ data: null, error: pgError('PGRST003') })
    expect((await marketCall({ p_page: 1, p_uid: 'u' })).error?.code).toBe('PGRST003')
    expect(cacheLife.mock.calls).toStrictEqual([['market'], ['auction']])
    expect(rpc.mock.calls.map((c) => c[0])).toStrictEqual(['market_list', 'market_list'])
  })
})

describe('auctionCall', () => {
  it('détail partagé, puis overlay de sa carte', async () => {
    expect(await auctionCall({ p_auction_id: 'x', p_uid: 'u' })).toStrictEqual({ data: { ...detail, auction: { id: 'x', card_id: 'a', owned: true } }, error: null })
    expect(rpc.mock.calls).toStrictEqual([['auction_detail', { p_auction_id: 'x' }], ['market_overlay', { p_uid: 'u', p_card_ids: ['a'] }]])
    expect(cacheLife.mock.calls).toStrictEqual([['auction']])
  })

  it.each(['P0001', '55P03', '40P01'])('%s de auction_detail → rendue en objet simple (code, message, details), jamais levée, sans overlay', async (code) => {
    rpc.mockResolvedValue({ data: null, error: pgError(code) })
    expect(await auctionCall({ p_auction_id: 'x', p_uid: 'u' }))
      .toStrictEqual({ data: null, error: { code, message: 'Enchère introuvable', details: '{"status":404}' } })
    expect(rpc.mock.calls.map((c) => c[0])).toStrictEqual(['auction_detail'])
    expect(cacheLife.mock.calls).toStrictEqual([['auction']])
  })

  it('autre erreur (08006) → une ligne de log avec pg_code, puis levée', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockResolvedValue({ data: null, error: pgError('08006') })
    await expect(auctionCall({ p_auction_id: 'x', p_uid: 'u' })).rejects.toThrow()
    expect(log.mock.calls).toStrictEqual([[JSON.stringify({ rpc: 'auction_detail', pg_code: '08006' })]])
    log.mockRestore()
  })
})

describe('salesCall', () => {
  it('p_scope summary → card_sales_summary partagé ; sans scope → card_sales avec p_uid, non caché', async () => {
    expect(await salesCall({ p_scope: 'summary', p_card_id: 'c', p_uid: 'u' })).toStrictEqual({ data: { summary: {} }, error: null })
    expect(cacheLife.mock.calls).toStrictEqual([['sales']])
    await salesCall({ p_card_id: 'c', p_uid: 'u' })
    expect(rpc.mock.calls).toStrictEqual([['card_sales_summary', { p_card_id: 'c' }], ['card_sales', { p_uid: 'u', p_card_id: 'c' }]])
    expect(cacheLife).toHaveBeenCalledTimes(1)
  })
})
