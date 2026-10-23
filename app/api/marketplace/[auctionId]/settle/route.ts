import { route } from '@/lib/route'
import { AuctionParams } from '@/lib/schemas'

export const POST = route({
  fn: 'settle_request',
  params: AuctionParams,
  idem: true,
  push: true,
  args: (_, { params }) => ({ p_auction_id: params.auctionId }),
})
