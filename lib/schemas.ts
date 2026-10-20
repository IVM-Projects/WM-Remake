import { z } from 'zod'

// Entrées des routes, partagées avec l'UI. Les query strings arrivent en chaînes (une clé répétée en tableau, lib/route.ts).
export const Rarity = z.enum(['C', 'PC', 'R', 'SR', 'UR', 'L'])
export const rarityList = z.union([z.array(Rarity), Rarity.transform((r) => [r])])
// Borné à l'int de PG : au-delà, un 22003 deviendrait un 500.
const intParam = z.coerce.number().int().min(0).max(2_147_483_647)
export const pageParam = intParam.default(0)
export const CollectionSort = z.enum(['rarity', 'obtained_at', 'added', 'name', 'atk', 'def', 'starred'])
export const boolParam = z.enum(['1', 'true', '0', 'false']).optional().transform((v) => v === '1' || v === 'true')
export const Username = z.string().min(1).max(64)

// Filtres de /api/my-collection et de /stats ; une clé inconnue (pending, stats, sort pour /stats) est ignorée.
export const CollectionFilters = z.object({
  q: z.string().optional(),
  search: z.string().optional(),
  rarity: rarityList.optional(),
  tag_id: z.uuid().optional(),
  untagged: boolParam,
  wishlisted_by: z.uuid().optional(),
  owned_by: z.uuid().optional(),
})
export const CollectionQuery = CollectionFilters.extend({ page: pageParam, limit: intParam.optional(), sort: CollectionSort.optional() })

export const filterArgs = (i: z.infer<typeof CollectionFilters>) => ({
  p_q: i.q ?? i.search, p_rarity: i.rarity, p_tag_id: i.tag_id, p_untagged: i.untagged, p_wishlisted_by: i.wishlisted_by, p_owned_by: i.owned_by,
})
