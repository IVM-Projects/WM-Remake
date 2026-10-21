import { z } from 'zod'
import { cardsCall } from '@/lib/catalog-cache'
import { route } from '@/lib/route'
import { boolParam, pageParam, rarityList } from '@/lib/schemas'

// Seuil de 2 caractères pour q vérifié en SQL (wm.cards_list) ; page partagée en cache, overlay du joueur à part (lib/catalog-cache.ts).
export const GET = route({
  fn: 'cards_page',
  input: z.object({ page: pageParam, sort: z.enum(['rarity']).optional(), q: z.string().optional(), rarity: rarityList.optional(),
    wishlist: boolParam, missing: boolParam }),
  args: (i) => ({ p_page: i.page, p_q: i.q, p_rarity: i.rarity, p_wishlist: i.wishlist, p_missing: i.missing }),
  call: cardsCall,
})
