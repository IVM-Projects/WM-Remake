'use client'

import { X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ghost } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { api, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { notificationView, unreadStore, type Notification } from '@/lib/notifications'

// Panneau de la cloche (M4-13) : les 50 dernières, lues à l'ouverture ; marquage d'une ligne ou de toutes, puis relecture du badge.
export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const store = unreadStore()
  const unread = useSyncExternalStore(store.subscribe, store.get, () => 0)
  const [list, setList] = useState<Notification[] | null>(null)
  const [failed, setFailed] = useState(false)
  // Une écriture à la fois : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const rows = useRef<HTMLUListElement>(null)
  const all = useRef<HTMLButtonElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  // Rang de la ligne dont le « Marquer comme lu » vient de disparaître sous le focus.
  const refocus = useRef<number | null>(null)

  // 2xx au corps illisible (api() rend null) : une lecture en échec, jamais le chargement sans fin.
  const load = () => api<{ notifications: Notification[] } | null>('/api/notifications')
    .then((r) => (Array.isArray(r?.notifications) ? setList(r.notifications) : setFailed(true)), () => setFailed(true))
  const onOpen = useEffectEvent(load)
  useEffect(() => void onOpen(), [])

  // Juste après le rendu qui retire le bouton, le focus tombé sur body va au « Marquer comme lu » suivant, sinon à « Tout marquer comme
  // lu ». Rien si le joueur a mis le focus ailleurs pendant la requête.
  useLayoutEffect(() => {
    const i = refocus.current
    refocus.current = null
    if (i === null || document.activeElement !== document.body) return
    const next = [...(rows.current?.children ?? [])].slice(i + 1).map((li) => li.querySelector('button')).find(Boolean)
    ;(next ?? all.current)?.focus()
  }, [list])

  // ids absent : tout lire.
  async function mark(ids?: string[], row?: number) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    try {
      await api('/api/notifications', { method: 'PATCH', body: JSON.stringify(ids ? { ids } : {}), idem: true })
      refocus.current = row ?? null
      setList((l) => l && l.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)))
      // Badge relu avant de rendre la main (refresh ne rejette jamais) : sinon un second Entrée sur « Tout marquer comme lu », lu avec
      // l'ancien compte, renverrait un PATCH {} sous une clé neuve.
      await store.refresh()
    } catch (e) {
      toast(userMessage(e, unsure(e) ? UNSURE : 'L\'action n\'a pas abouti.'))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  // Voulu, même sous « Aucune notification. » : « Tout marquer comme lu » suit aussi le badge, pour effacer les non-lues au-delà des 50 affichées.
  const none = !unread && !list?.some((n) => !n.read)
  return (
    <Modal onClose={onClose} label="Notifications" className="card-frame relative w-full max-w-md animate-fade-in-up p-6 max-h-[90vh] overflow-y-auto">
      <button
        type="button"
        aria-label="Fermer"
        onClick={onClose}
        className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-light)]"
      >
        <X className="size-6" />
      </button>
      <h2 ref={title} tabIndex={-1} className="mb-4 pr-10 text-xl font-bold outline-none">Notifications</h2>
      {failed ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p role="alert" className="text-sm">Impossible de charger cette page.</p>
          <button
            type="button"
            // « Réessayer » disparaît pendant la relecture : le focus passe au titre, jamais sur body.
            onClick={() => {
              title.current?.focus()
              setFailed(false)
              void load()
            }}
            className={ghost}
          >
            Réessayer
          </button>
        </div>
      ) : !list ? (
        <Loading label="Chargement des notifications" />
      ) : (
        <>
          <button
            ref={all}
            type="button"
            aria-disabled={none || busy || undefined}
            onClick={() => { if (!none) void mark() }}
            className={`${ghost} mb-2`}
          >
            Tout marquer comme lu
          </button>
          {list.length === 0 ? (
            <p className="py-6 text-center text-sm">Aucune notification.</p>
          ) : (
            <ul ref={rows} aria-label="Notifications récentes" className="divide-y divide-[var(--color-border)]">
              {list.map((n, i) => {
                const { text, href } = notificationView(n)
                const weight = n.read ? '' : 'font-semibold'
                return (
                  <li key={n.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1 text-sm">
                      {href ? (
                        <Link href={href} onNavigate={onClose} className={`flex min-h-11 items-center underline-offset-2 hover:underline ${weight}`}>
                          {text}
                        </Link>
                      ) : (
                        <p className={weight}>{text}</p>
                      )}
                      <time dateTime={n.created_at} className="text-xs tabular-nums text-[var(--color-foreground)]/70">
                        {formatDateTime(n.created_at)}
                      </time>
                    </div>
                    {!n.read && (
                      <button type="button" aria-disabled={busy || undefined} onClick={() => void mark([n.id], i)} className={`${ghost} shrink-0`}>
                        Marquer comme lu
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </Modal>
  )
}
