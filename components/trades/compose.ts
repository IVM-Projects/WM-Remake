import type { z } from 'zod'
import type { TradeBody } from '@/lib/schemas'
import type { Trade } from './types'

// user_card_id → quantité choisie (unités d'une pile).
export type Picks = Record<string, number>

// Corps de POST /api/trades : une unité par élément, les miens puis ceux de l'ami, triés par user_card_id (intention apiOnce stable, P18).
export function buildBody(o: {
  recipientId: string
  me: string
  offer: Picks
  ask: Picks
  cardOf: Record<string, string>
  wbOffer: number
  wbAsk: number
  parentId?: string
}): z.input<typeof TradeBody> {
  const units = (p: Picks, by: string) => Object.keys(p).sort().flatMap((id) =>
    Array.from({ length: p[id] }, () => ({ user_card_id: id, card_id: o.cardOf[id], offered_by: by })))
  return {
    recipient_id: o.recipientId,
    items: [...units(o.offer, o.me), ...units(o.ask, o.recipientId)],
    initiator_wikibidous: o.wbOffer,
    recipient_wikibidous: o.wbAsk,
    ...(o.parentId && { parent_trade_id: o.parentId }),
  }
}

// Contre-offre préremplie à l'inverse, vue par le destinataire `me` : j'offre ce que le parent me demandait, je demande ce qu'il m'offrait.
export function invertTrade(parent: Trade, me: string) {
  const of = (by: string) => {
    const p: Picks = {}
    for (const i of parent.items) if (i.offered_by === by) p[i.user_card_id] = (p[i.user_card_id] ?? 0) + 1
    return p
  }
  return {
    withId: parent.initiator_id,
    offer: of(me),
    ask: of(parent.initiator_id),
    cardOf: Object.fromEntries(parent.items.map((i) => [i.user_card_id, i.card_id])) as Record<string, string>,
    wbOffer: parent.recipient_wikibidous,
    wbAsk: parent.initiator_wikibidous,
  }
}

export const sideCount = (p: Picks): number => Object.values(p).reduce((n, q) => n + q, 0)
