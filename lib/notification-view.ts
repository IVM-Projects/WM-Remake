import { formatInt, wikibidous } from '@/lib/format'

// Module pur (B4) : partagé par la cloche (lib/notifications.ts, qui le réexporte) et par le push (lib/push.ts).
// Ligne de GET /api/notifications (wm.notifications_list) ; data en snake_case, sans texte (M3-8, M4-12).
export type Notification = { id: string; type: string; data: Record<string, unknown>; read: boolean; created_at: string }

// Texte et lien par type (P14) ; {u} = l'auteur de l'action, {c} = le titre de la copie, sinon celui du catalogue.
export function notificationView({ type, data }: Pick<Notification, 'type' | 'data'>): { text: string; href: string | null } {
  const u = data.username
  const c = data.card_title ?? data.wikipedia_title
  const amount = Number(data.amount)
  const price = () => `${formatInt(amount)} ${wikibidous(amount)}`
  const trade = `/trades/${data.trade_id}`
  const auction = `/marketplace/${data.auction_id}`
  const battle = `/battle/${data.battle_id}`
  switch (type) {
    case 'trade_received': return { text: `${u} te propose un échange`, href: trade }
    case 'trade_countered': return { text: `${u} a fait une contre-offre`, href: trade }
    case 'trade_accepted': return { text: `${u} a accepté ton échange`, href: trade }
    case 'trade_declined': return { text: `${u} a refusé ton échange`, href: trade }
    case 'trade_cancelled': return { text: `${u} a annulé son échange`, href: trade }
    case 'friend_request': return { text: `${u} veut devenir ton ami`, href: '/friends' }
    case 'friend_accepted': return { text: `${u} a accepté ta demande d'ami`, href: '/friends' }
    case 'auction_outbid': return { text: `Tu as été surenchéri sur ${c}`, href: auction }
    case 'auction_won': return { text: `Tu as remporté ${c} pour ${price()}`, href: auction }
    case 'auction_sold': return { text: `${c} vendue pour ${price()}`, href: auction }
    case 'auction_unsold': return { text: `${c} n'a pas trouvé preneur`, href: auction }
    case 'wishlist_listed': return { text: `${c}, de ta liste de souhaits, est en vente`, href: auction }
    case 'chat_message': return { text: `${u} t'a écrit`, href: `/dms?with=${data.user_id}` }
    // Cloche seulement : aucun type battle_* n'est dans push_types (M5a-13).
    case 'battle_invite': return { text: `${u} te défie en bataille`, href: battle }
    case 'battle_accepted': return { text: `${u} a accepté ton défi`, href: battle }
    case 'battle_declined': return { text: `${u} a refusé ton défi`, href: battle }
    case 'battle_started': return { text: `${u} a choisi ses cartes : la bataille commence`, href: battle }
    case 'battle_attacked': return { text: `${u} t'attaque : à toi de répondre`, href: battle }
    case 'battle_won': return { text: `Victoire contre ${u}`, href: battle }
    case 'battle_lost': return { text: `Défaite contre ${u}`, href: battle }
    default: return { text: 'Nouvelle notification', href: null }
  }
}

// Familles de /settings (M4b-13) : chaque case écrit tous les types de sa famille.
export const PUSH_FAMILIES: readonly { label: 'Messages' | 'Échanges' | 'Amis' | 'Marché'; types: readonly string[] }[] = [
  { label: 'Messages', types: ['chat_message'] },
  { label: 'Échanges', types: ['trade_accepted', 'trade_cancelled', 'trade_countered', 'trade_declined', 'trade_received'] },
  { label: 'Amis', types: ['friend_accepted', 'friend_request'] },
  { label: 'Marché', types: ['auction_outbid', 'auction_sold', 'auction_unsold', 'auction_won', 'wishlist_listed'] },
]

// Les 13 types triés, ceux de wm.config.push_types (1800).
export function pushTypes(): string[] {
  return PUSH_FAMILIES.flatMap((f) => f.types).sort()
}
