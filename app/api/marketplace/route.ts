import { z } from 'zod'
import { marketCall } from '@/lib/market-cache'
import { route } from '@/lib/route'
import { MarketQuery } from '@/lib/schemas'

// Liste partagée en cache + overlay owned, ou onglets du joueur sans cache avec mine=1 (lib/market-cache.ts, M3-19).
export const GET = route({
  fn: 'market_list',
  input: MarketQuery,
  args: (i) => ({ p_page: i.page, p_limit: i.limit, p_sort: i.sort, p_q: i.q, p_rarity: i.rarity, p_card_id: i.card_id, p_mine: i.mine }),
  call: marketCall,
})

export const POST = route({
  fn: 'create_auction',
  status: 201,
  input: z.object({ card_id: z.uuid(), base_amount: z.int32(), duration_minutes: z.int32() }),
  idem: true,
  args: (i) => ({ p_card_id: i.card_id, p_base_amount: i.base_amount, p_duration_minutes: i.duration_minutes }),
})
