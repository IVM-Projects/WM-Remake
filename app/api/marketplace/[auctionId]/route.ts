import { route } from '@/lib/route'
import { AuctionParams } from '@/lib/schemas'

export const DELETE = route({
  fn: 'cancel_auction',
  params: AuctionParams,
  idem: true,
  args: (_, { params }) => ({ p_auction_id: params.auctionId }),
})
