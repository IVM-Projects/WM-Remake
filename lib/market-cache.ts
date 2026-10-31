import { cacheLife, cacheTag } from 'next/cache'
import { normalizeQ } from '@/lib/catalog-cache'
import { BUSY_CODES, type RpcResult } from '@/lib/route'
import { createAdminClient } from '@/lib/supabase/admin'

// Partie de l'objet Auction lue ici ; le reste passe tel quel (M3-19).
type Auction = { card_id: string }

// Lecture partagée (P10, P14 du M2) : une erreur levée perdrait code et details en traversant le cache, donc un P0001 (déterministe) et un
// code occupé sont rendus ; route() en fait le statut du détail ou un 503 BUSY avec Retry-After.
export async function sharedRpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await createAdminClient().schema('wm').rpc(fn, args)
  if (!error) return { data, error: null }
  if (error.code === 'P0001' || BUSY_CODES.has(error.code)) return { data: null, error: { code: error.code, message: error.message, details: error.details } }
  // shortcut: toute autre erreur devient un 500 (comme lib/catalog-cache.ts) ; la rendre sous cacheLife('auction') si des 500 apparaissent.
  console.error(JSON.stringify({ rpc: fn, pg_code: error.code ?? null }))
  throw new Error(`${fn} : ${error.code}`)
}

// Un code occupé n'est gardé qu'une seconde (profil auction), quel que soit le profil de la donnée ; un seul cacheLife par appel, chaque
// branche le sien (cacheLife.md, « Conditional cache lifetimes » : les surcharges typées refusent une union).
export const busy = (r: RpcResult) => r.error !== null && r.error.code !== 'P0001'

// Liste sans joueur, la même pour tous (M3-19) : les arguments forment la clé, normalisée par marketCall (P24).
export async function sharedMarketList(page: number, limit: number, sort: string, q: string | null, rarity: string[] | null,
  cardId: string | null): Promise<RpcResult> {
  'use cache: remote'
  cacheTag('market')
  const out = await sharedRpc('market_list', { p_page: page, p_limit: limit, p_sort: sort, p_q: q, p_rarity: rarity, p_card_id: cardId })
  if (busy(out)) cacheLife('auction')
  else cacheLife('market')
  return out
}

// Détail partagé ; auction_detail règle d'abord une enchère échue, à chaque cache manqué (M3-19).
// shortcut: le règlement paresseux de ce détail insère des notifications sous 'use cache: remote', donc sans after() ; leur push part au drain suivant (réveil de 15 s sur la démo, after() d'une autre route ou cron) ; sortir le règlement du cache si ce délai gêne.
export async function sharedAuction(id: string): Promise<RpcResult> {
  'use cache: remote'
  cacheTag('market')
  cacheLife('auction')
  return await sharedRpc('auction_detail', { p_auction_id: id })
}

export async function sharedSalesSummary(cardId: string): Promise<RpcResult> {
  'use cache: remote'
  cacheTag('market')
  const out = await sharedRpc('card_sales_summary', { p_card_id: cardId })
  if (busy(out)) cacheLife('auction')
  else cacheLife('sales')
  return out
}

// Overlay du joueur (M3-19) : `owned` posé sur chaque enchère, sans toucher l'objet partagé ; une erreur de l'overlay est relayée.
async function withOwned(uid: unknown, auctions: Auction[], build: (auctions: Auction[]) => unknown): Promise<RpcResult> {
  const { data, error } = await createAdminClient().schema('wm')
    .rpc('market_overlay', { p_uid: uid, p_card_ids: [...new Set(auctions.map((a) => a.card_id))] })
  if (error) return { data: null, error }
  const owned = new Set((data as { ownedCardIds: string[] }).ownedCardIds)
  return { data: build(auctions.map((a) => ({ ...a, owned: owned.has(a.card_id) }))), error: null }
}

// Appel de GET /api/marketplace : onglets du joueur sans cache ; sinon liste partagée en cache + overlay.
export async function marketCall(args: Record<string, unknown>): Promise<RpcResult> {
  if (args.p_mine) return await createAdminClient().schema('wm').rpc('market_mine_lists', { p_uid: args.p_uid, p_page: args.p_page })
  const rarity = args.p_rarity as string[] | undefined
  const shared = await sharedMarketList(args.p_page as number, Math.min(Math.max((args.p_limit as number | undefined) ?? 50, 1), 50),
    (args.p_sort as string | undefined) ?? 'recent', normalizeQ(args.p_q as string | undefined),
    rarity?.length ? [...new Set(rarity)].sort() : null, (args.p_card_id as string | undefined) ?? null)
  if (shared.error) return shared
  const list = shared.data as { auctions: Auction[] }
  return await withOwned(args.p_uid, list.auctions, (auctions) => ({ ...list, auctions }))
}

// Appel de GET /api/marketplace/{id} : détail partagé + overlay de sa carte.
export async function auctionCall(args: Record<string, unknown>): Promise<RpcResult> {
  const shared = await sharedAuction(args.p_auction_id as string)
  if (shared.error) return shared
  const detail = shared.data as { auction: Auction }
  return await withOwned(args.p_uid, [detail.auction], ([auction]) => ({ ...detail, auction }))
}

// Appel de GET /api/marketplace/cards/{cardId}/sales : résumé partagé, ou détail Pro par joueur sans cache.
export async function salesCall(args: Record<string, unknown>): Promise<RpcResult> {
  if (args.p_scope === 'summary') return await sharedSalesSummary(args.p_card_id as string)
  return await createAdminClient().schema('wm').rpc('card_sales', { p_uid: args.p_uid, p_card_id: args.p_card_id })
}
