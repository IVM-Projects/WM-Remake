import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createUnreadStore, notificationView, type Notification } from './notifications'

// Sans DOM (R18) : document simulé par un EventTarget, minuteurs simulés ; le singleton unreadStore() n'est jamais touché ici.
const doc = () => Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('deux abonnés : un seul fetchUnread tout de suite, puis un seul à 30 s', async () => {
  const fetchUnread = vi.fn().mockResolvedValue(3)
  const store = createUnreadStore({ fetchUnread, doc: doc() })
  store.subscribe(() => {})
  store.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchUnread).toHaveBeenCalledTimes(1)
  expect(store.get()).toBe(3)
  await vi.advanceTimersByTimeAsync(29_999)
  expect(fetchUnread).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetchUnread).toHaveBeenCalledTimes(2)
})

test('le premier qui part laisse le poller ; les deux désabonnés : aucun appel pendant 60 s, même au retour en visible', async () => {
  const fetchUnread = vi.fn().mockResolvedValue(1)
  const d = doc()
  const store = createUnreadStore({ fetchUnread, doc: d })
  const [a, b] = [store.subscribe(() => {}), store.subscribe(() => {})]
  await vi.advanceTimersByTimeAsync(0)
  a()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(fetchUnread).toHaveBeenCalledTimes(2)
  b()
  d.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetchUnread).toHaveBeenCalledTimes(2)
})

test('refresh() : un appel immédiat, les abonnés reçoivent le nouveau compte', async () => {
  const fetchUnread = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2)
  const store = createUnreadStore({ fetchUnread, doc: doc() })
  const cb = vi.fn()
  store.subscribe(cb)
  await vi.advanceTimersByTimeAsync(0)
  expect(cb).toHaveBeenCalledTimes(1)
  await store.refresh()
  expect(fetchUnread).toHaveBeenCalledTimes(2)
  expect(cb).toHaveBeenCalledTimes(2)
  expect(store.get()).toBe(2)
})

test('un fetchUnread rejeté garde le compte précédent ; une lecture dépassée par une plus récente est jetée', async () => {
  let slow: (n: number) => void = () => {}
  const fetchUnread = vi.fn()
    .mockResolvedValueOnce(4)
    .mockRejectedValueOnce(new Error('réseau'))
    .mockReturnValueOnce(new Promise<number>((r) => { slow = r }))
    .mockResolvedValueOnce(1)
  const store = createUnreadStore({ fetchUnread, doc: doc() })
  store.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(0)
  await store.refresh()
  expect(store.get()).toBe(4)
  // Passage du poller en vol, puis relecture après un marquage : la seconde gagne, même finie avant.
  const stale = store.refresh()
  await store.refresh()
  slow(4)
  await stale
  expect(store.get()).toBe(1)
})

const n = (type: string, data: Record<string, unknown>): Notification => ({ id: 'n-1', type, data, read: false, created_at: '2026-10-22T10:00:00Z' })

test('notificationView : texte et lien des 12 types, et d\'un type inconnu', () => {
  const t = { trade_id: 't-1', user_id: 'u-1', username: 'Alice' }
  const f = { friendship_id: 'f-1', user_id: 'u-1', username: 'Alice' }
  // data de wm.notification_data (M3) : card_title (snapshot de la copie) avant wikipedia_title.
  const a = { auction_id: 'a-1', card_id: 'c-1', card_title: 'Chat', wikipedia_title: 'Chat (animal)', amount: 1234 }
  const views = [
    n('trade_received', t), n('trade_countered', t), n('trade_accepted', t), n('trade_declined', t), n('trade_cancelled', t),
    n('friend_request', f), n('friend_accepted', f),
    n('auction_outbid', a), n('auction_won', a), n('auction_sold', a), n('auction_unsold', a), n('wishlist_listed', { ...a, card_title: undefined }),
    n('guild_invite', { guild_id: 'g-1' }),
  ].map(notificationView)
  expect(views).toEqual([
    { text: 'Alice te propose un échange', href: '/trades/t-1' },
    { text: 'Alice a fait une contre-offre', href: '/trades/t-1' },
    { text: 'Alice a accepté ton échange', href: '/trades/t-1' },
    { text: 'Alice a refusé ton échange', href: '/trades/t-1' },
    { text: 'Alice a annulé son échange', href: '/trades/t-1' },
    { text: 'Alice veut devenir ton ami', href: '/friends' },
    { text: 'Alice a accepté ta demande d\'ami', href: '/friends' },
    { text: 'Tu as été surenchéri sur Chat', href: '/marketplace/a-1' },
    // Espace fine insécable U+202F de formatInt.
    { text: 'Tu as remporté Chat pour 1 234 wikibidous', href: '/marketplace/a-1' },
    { text: 'Chat vendue pour 1 234 wikibidous', href: '/marketplace/a-1' },
    { text: 'Chat n\'a pas trouvé preneur', href: '/marketplace/a-1' },
    { text: 'Chat (animal), de ta liste de souhaits, est en vente', href: '/marketplace/a-1' },
    { text: 'Nouvelle notification', href: null },
  ])
  // Une unité au singulier (wikibidous(1)).
  expect(notificationView(n('auction_sold', { ...a, amount: 1 })).text).toBe('Chat vendue pour 1 wikibidou')
})
