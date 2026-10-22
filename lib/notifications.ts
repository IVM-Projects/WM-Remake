import { formatInt, wikibidous } from '@/lib/format'
import { createPoller } from '@/lib/poll'
import { createBrowserSupabase } from '@/lib/supabase/browser'

// Ligne de GET /api/notifications (wm.notifications_list) ; data en snake_case, sans texte (M3-8, M4-12).
export type Notification = { id: string; type: string; data: Record<string, unknown>; read: boolean; created_at: string }

type Doc = Parameters<typeof createPoller>[0]['doc']

// Compte des non-lues partagé par toutes les cloches (M4-13) : un seul poller, lancé au premier abonné, arrêté au départ du dernier.
export function createUnreadStore(o: {
  fetchUnread: () => Promise<number>
  delay?: number
  doc?: Doc
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}): { subscribe(cb: () => void): () => void; get(): number; refresh(): Promise<void> } {
  const { fetchUnread, delay = 30_000, doc, setTimer, clearTimer } = o
  const subs = new Set<() => void>()
  let count = 0
  let last = 0
  let stop: (() => void) | undefined
  // Lecture en échec : le compte précédent reste. Seule la dernière lecture partie compte : un passage du poller fini après la relecture
  // d'un marquage ne remet pas l'ancien compte.
  async function refresh() {
    const mine = ++last
    try {
      const n = await fetchUnread()
      if (mine !== last || n === count) return
      count = n
      subs.forEach((cb) => cb())
    } catch {}
  }
  // Fonctions sans this : useSyncExternalStore les reçoit détachées (P14).
  const subscribe = (cb: () => void) => {
    subs.add(cb)
    if (subs.size === 1) {
      void refresh()
      stop = createPoller({ run: refresh, delay: () => delay, doc, setTimer, clearTimer })
    }
    return () => {
      subs.delete(cb)
      if (subs.size) return
      stop?.()
      stop = undefined
    }
  }
  return { subscribe, get: () => count, refresh }
}

let store: ReturnType<typeof createUnreadStore> | undefined

// Singleton paresseux (P14) : le client Supabase n'est créé qu'à la première lecture, jamais au rendu serveur.
export function unreadStore() {
  return (store ??= createUnreadStore({
    fetchUnread: async () => {
      // 10 lignes suffisent : le badge dit « 9+ » dès 10.
      const { data, error } = await createBrowserSupabase().from('notifications').select('id').eq('read', false).limit(10)
      if (error) throw error
      return data.length
    },
  }))
}

// Texte et lien par type (P14) ; {u} = l'auteur de l'action, {c} = le titre de la copie, sinon celui du catalogue.
export function notificationView({ type, data }: Notification): { text: string; href: string | null } {
  const u = data.username
  const c = data.card_title ?? data.wikipedia_title
  const amount = Number(data.amount)
  const price = () => `${formatInt(amount)} ${wikibidous(amount)}`
  const trade = `/trades/${data.trade_id}`
  const auction = `/marketplace/${data.auction_id}`
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
    default: return { text: 'Nouvelle notification', href: null }
  }
}
