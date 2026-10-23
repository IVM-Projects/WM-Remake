import type { RarityCode } from '@/lib/rarity'

// Objet Trade de wm.trade_json (P7, contract/spec/trades.ts) ; un pending échu arrive déjà en expired (P3).
export type TradeStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered'

export type TradeItem = {
  offered_by: string
  card_id: string
  user_card_id: string
  snapshot_rarity: RarityCode
  is_shiny: boolean
  card: { id: string; wikipedia_title: string; image_url: string | null; rarity: RarityCode }
}

export type Trade = {
  id: string
  status: TradeStatus
  initiator_id: string
  recipient_id: string
  initiator_wikibidous: number
  recipient_wikibidous: number
  parent_trade_id: string | null
  created_at: string
  updated_at: string
  accepted_at: string | null
  completed_at: string | null
  closed_at: string | null
  expires_at: string
  initiator: { id: string; username: string }
  recipient: { id: string; username: string }
  items: TradeItem[]
  counter_trade_id: string | null
}

// Statuts affichés (P17) : la carte de la liste les préfixe de « · », le détail non.
export const STATUS_LABEL: Record<TradeStatus, { text: string; className: string }> = {
  pending: { text: 'En attente', className: 'text-amber-600' },
  accepted: { text: 'Accepté', className: 'text-green-400' },
  declined: { text: 'Refusé', className: 'text-red-400' },
  cancelled: { text: 'Annulé', className: 'text-[var(--color-foreground)]/60' },
  expired: { text: 'Expiré', className: 'text-[var(--color-foreground)]/60' },
  countered: { text: 'Contre-offre', className: 'text-sky-400' },
}

// Puce (P15) : « SR · <titre tronqué à 20 caractères>… », rareté figée à la création (P2).
export function chipText(item: TradeItem): string {
  const t = item.card.wikipedia_title
  return `${item.snapshot_rarity} · ${t.length > 20 ? `${t.slice(0, 20)}…` : t}`
}
