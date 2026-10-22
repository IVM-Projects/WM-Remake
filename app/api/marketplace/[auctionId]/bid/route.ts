import { z } from 'zod'
import { route } from '@/lib/route'
import { AuctionParams } from '@/lib/schemas'

export const POST = route({
  fn: 'place_bid',
  params: AuctionParams,
  input: z.object({ amount: z.int32() }),
  idem: true,
  args: (i, { params }) => ({ p_auction_id: params.auctionId, p_amount: i.amount }),
})
