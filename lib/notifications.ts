import { createPoller } from '@/lib/poll'
import { createBrowserSupabase } from '@/lib/supabase/browser'

// Module pur, lu aussi par lib/push.ts côté serveur (B4).
export { notificationView, type Notification } from '@/lib/notification-view'

type Doc = Parameters<typeof createPoller>[0]['doc']

// Compte des non-lues partagé par toutes les cloches (M4-13) : un seul poller, lancé au premier abonné, arrêté au départ du dernier.
export function createUnreadStore(o: {
  fetchUnread: () => Promise<number>
  delay?: number
  doc?: Doc
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}): { subscribe(cb: () => void): () => void; get(): number; getVersion(): number; refresh(): Promise<void> } {
  const { fetchUnread, delay = 30_000, doc, setTimer, clearTimer } = o
  const subs = new Set<() => void>()
  let count = 0
  // +1 à chaque lecture appliquée, compte changé ou non : au-delà de « 9+ », le compte plafonné ne bouge plus, la version si.
  let version = 0
  let last = 0
  let stop: (() => void) | undefined
  // Lecture en échec : le compte et la version restent. Seule la dernière lecture partie compte : un passage du poller fini après la
  // relecture d'un marquage ne remet pas l'ancien compte. Les abonnés sont appelés à chaque version ; useSyncExternalStore ne rend de
  // nouveau que si leur instantané (get ou getVersion) a changé.
  async function refresh() {
    const mine = ++last
    try {
      const n = await fetchUnread()
      if (mine !== last) return
      count = n
      version++
      subs.forEach((cb) => cb())
    } catch {}
  }
  // Fonctions sans this : useSyncExternalStore les reçoit détachées (P14).
  const subscribe = (cb: () => void) => {
    subs.add(cb)
    // Sur stop, pas sur la taille : un même rappel abonné deux fois laisse le Set à 1 et lancerait un second poller, jamais arrêté.
    if (!stop) {
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
  return { subscribe, get: () => count, getVersion: () => version, refresh }
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
