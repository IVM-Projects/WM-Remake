import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PUSH_FAMILIES, pushTypes } from './notification-view'
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

test('le même rappel abonné deux fois : une seule lecture tout de suite ; les deux désabonnés, aucun appel pendant 60 s', async () => {
  const fetchUnread = vi.fn().mockResolvedValue(1)
  const store = createUnreadStore({ fetchUnread, doc: doc() })
  const cb = () => {}
  const offs = [store.subscribe(cb), store.subscribe(cb)]
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchUnread).toHaveBeenCalledTimes(1)
  offs.forEach((off) => off())
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetchUnread).toHaveBeenCalledTimes(1)
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

test('version : +1 à chaque lecture réussie (poller et refresh), même à compte égal, abonnés appelés ; rien sur un échec ; compte inchangé', async () => {
  // 12 non lues : 10 lignes lues (« 9+ »), un compte qui ne bouge plus.
  const fetchUnread = vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(10).mockRejectedValueOnce(new Error('réseau')).mockResolvedValueOnce(10)
  const store = createUnreadStore({ fetchUnread, doc: doc() })
  // Fonctions détachées, comme les reçoit useSyncExternalStore (P14).
  const { get, getVersion } = store
  const cb = vi.fn()
  store.subscribe(cb)
  expect(getVersion()).toBe(0)
  const seen = () => [get(), getVersion(), cb.mock.calls.length]
  await vi.advanceTimersByTimeAsync(0)
  expect(seen()).toEqual([10, 1, 1])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(seen()).toEqual([10, 2, 2])
  await store.refresh()
  expect(seen()).toEqual([10, 2, 2])
  await store.refresh()
  expect(seen()).toEqual([10, 3, 3])
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
  // Le premier passage et la relecture gagnante seulement : ni l'échec ni la lecture jetée ne font de version.
  expect(store.getVersion()).toBe(2)
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

test('notificationView : chat_message → « Alice t\'a écrit », lien du fil (M4b-4)', () => {
  expect(notificationView(n('chat_message', { user_id: 'u-1', username: 'Alice' }))).toEqual({ text: 'Alice t\'a écrit', href: '/dms?with=u-1' })
})

test('PUSH_FAMILIES aplati et trié = pushTypes() = push_types de 1800 ; chaque type a son texte', () => {
  const sql = readFileSync(new URL('../supabase/migrations/1800_wm_social_core.sql', import.meta.url), 'utf8')
  const seeded: unknown = JSON.parse(/'push_types',\s*'(\[[^']*\])'/.exec(sql)?.[1] ?? 'null')
  expect(PUSH_FAMILIES.flatMap((f) => f.types).sort()).toEqual(pushTypes())
  expect(pushTypes()).toEqual(seeded)
  for (const type of pushTypes()) expect(notificationView({ type, data: {} }).text, type).not.toBe('Nouvelle notification')
})
