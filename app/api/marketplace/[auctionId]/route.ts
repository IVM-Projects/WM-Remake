import { auctionCall } from '@/lib/market-cache'
import { route } from '@/lib/route'
import { AuctionParams } from '@/lib/schemas'

// Détail partagé en cache (règlement paresseux d'une enchère échue à chaque cache manqué) + overlay owned (M3-19).
export const GET = route({
  fn: 'auction_detail',
  params: AuctionParams,
  args: (_, { params }) => ({ p_auction_id: params.auctionId }),
  call: auctionCall,
})

export const DELETE = route({
  fn: 'cancel_auction',
  params: AuctionParams,
  idem: true,
  args: (_, { params }) => ({ p_auction_id: params.auctionId }),
})
