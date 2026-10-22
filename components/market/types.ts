import type { CardFace } from '@/components/card/Card'
import type { RarityCode } from '@/lib/rarity'

// Objet Auction de wm.auction_json (M3-19, contract/spec/market.ts) ; owned, my_last_bid et my_state viennent des réponses par joueur.
export type Auction = {
  id: string
  seller_id: string
  card_id: string
  user_card_id: string
  snapshot_rarity: RarityCode
  snapshot_atk: number | null
  snapshot_def: number | null
  snapshot_search_document: string | null
  is_shiny: boolean
  base_amount: number
  listing_base_amount: number
  base_repriced_at: string | null
  current_bid: number | null
  current_bidder_id: string | null
  bids_count: number
  final_price: number | null
  status: 'active' | 'settled_sold' | 'settled_unsold' | 'cancelled'
  end_at: string
  created_at: string
  settled_at: string | null
  winner_id: string | null
  seller: { id: string; username: string }
  current_bidder: { username: string } | null
  card: {
    id: string
    wikipedia_title: string
    wikipedia_url: string
    rarity: RarityCode
    category: string | null
    image_url: string | null
    hide_image: boolean
    nsfw_image: boolean
    atk: number
    def: number
    q_score: number | null
    pageviews: number
  }
  effective_bid: number
  bid_count: number
  buyer_id: string | null
  min_next_bid: number | null
  owned?: boolean
  my_last_bid?: number
  my_state?: 'leading' | 'outbid' | 'won' | 'lost'
}

// ?mine=1&page=n (wm.market_mine_lists) : bidding, won et history par pages de 50, selling entier.
export type MineLists = {
  mine: true
  selling: Auction[]
  bidding: Auction[]
  won: Auction[]
  history: Auction[]
  counts: { selling: number; bidding: number; won: number; history: number }
  wonHasMore: boolean
  historyHasMore: boolean
  sellingCount: number
  maxConcurrentAuctions: number
}

// Face figée à la mise en vente (P30, R§4.2) : card.rarity est la rareté du catalogue, que catalog_merge réécrit.
export const auctionFace = (a: Auction): CardFace => ({ ...a.card, rarity: a.snapshot_rarity, atk: a.snapshot_atk, def: a.snapshot_def })
