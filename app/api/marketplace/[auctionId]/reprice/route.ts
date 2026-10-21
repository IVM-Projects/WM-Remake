import { z } from 'zod'
import { route } from '@/lib/route'
import { AuctionParams } from '@/lib/schemas'

export const POST = route({
  fn: 'reprice_auction',
  params: AuctionParams,
  input: z.object({ new_base_amount: z.int32() }),
  idem: true,
  args: (i, { params }) => ({ p_auction_id: params.auctionId, p_new_base_amount: i.new_base_amount }),
})
