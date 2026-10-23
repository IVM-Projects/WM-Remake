import { z } from 'zod'

// Entrées des routes, partagées avec l'UI. Les query strings arrivent en chaînes (une clé répétée en tableau, lib/route.ts).
export const Rarity = z.enum(['C', 'PC', 'R', 'SR', 'UR', 'L'])
export const rarityList = z.union([z.array(Rarity), Rarity.transform((r) => [r])])
// Borné à l'int de PG : au-delà, un 22003 deviendrait un 500.
const intParam = z.coerce.number().int().min(0).max(2_147_483_647)
export const pageParam = intParam.default(0)
export const CollectionSort = z.enum(['rarity', 'obtained_at', 'added', 'name', 'atk', 'def', 'starred'])
export const boolParam = z.enum(['1', 'true', '0', 'false']).optional().transform((v) => v === '1' || v === 'true')
// Postgres refuse \0 dans un texte (22P05), PostgREST une demi-paire UTF-16 seule (PGRST102) : sans ce refus, un 500 au lieu d'un 400.
// Tout texte libre qui atteint le SQL passe par lui. \p{Cs} sous `u` ne voit que les demi-paires seules (isWellFormed manque aux Firefox d'avant 119).
export const pgText = z.string().refine((s) => !s.includes('\0') && !/\p{Cs}/u.test(s), 'Caractère invalide')
export const Username = pgText.min(1).max(64)
export const AuctionParams = z.object({ auctionId: z.uuid() })
export const FriendshipParams = z.object({ friendshipId: z.uuid() })
export const TradeParams = z.object({ tradeId: z.uuid() })
// Corps de POST /api/trades, partagé avec le composer. items : une unité par élément, deux côtés × 100 ; les plafonds par côté et leurs
// messages français sont des règles SQL (P11).
export const TradeBody = z.object({
  recipient_id: z.uuid(),
  items: z.array(z.object({ user_card_id: z.uuid(), card_id: z.uuid(), offered_by: z.uuid() })).max(200),
  initiator_wikibidous: z.int32().default(0),
  recipient_wikibidous: z.int32().default(0),
  parent_trade_id: z.uuid().nullish(),
})
// GET /api/marketplace : page à partir de 1, gardée ici pour la clé du cache et en SQL (P24) ; tri validé en SQL (« Tri inconnu »).
export const MarketQuery = z.object({ page: z.coerce.number().int().min(1, 'La page commence à 1').max(2_147_483_647).default(1),
  limit: z.coerce.number().int().optional(), sort: pgText.optional(), q: pgText.optional(), rarity: rarityList.optional(), mine: boolParam,
  card_id: z.uuid().optional() })

// Filtres de /api/my-collection et de /stats ; une clé inconnue (pending, stats, sort pour /stats) est ignorée.
export const CollectionFilters = z.object({
  q: pgText.optional(),
  search: pgText.optional(),
  rarity: rarityList.optional(),
  tag_id: z.uuid().optional(),
  untagged: boolParam,
  wishlisted_by: z.uuid().optional(),
  owned_by: z.uuid().optional(),
})
export const CollectionQuery = CollectionFilters.extend({ page: pageParam, limit: intParam.optional(), sort: CollectionSort.optional() })

export const filterArgs = (i: z.infer<typeof CollectionFilters>) => ({
  // || et non ?? : un q= vide ne masque pas search.
  p_q: i.q || i.search,
  p_rarity: i.rarity, p_tag_id: i.tag_id, p_untagged: i.untagged, p_wishlisted_by: i.wishlisted_by, p_owned_by: i.owned_by,
})
