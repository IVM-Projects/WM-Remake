'use client'

import { Bell as BellIcon } from 'lucide-react'
import { useId, useState, useSyncExternalStore } from 'react'
import { NotificationPanel } from '@/components/shell/NotificationPanel'
import { unreadStore } from '@/lib/notifications'

// `aria-label="Notifications"` est un sélecteur d'extension (R§6.8) : nom figé, le compte passe par aria-describedby (M4-13).
export function BellButton({ unread, onClick, describedBy }: { unread: number; onClick: () => void; describedBy: string }) {
  // Badge à côté du bouton, pas dedans : un chiffre visible absent du nom figé ferait lever label-content-name-mismatch (WCAG 2.5.3).
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="Notifications"
        aria-describedby={describedBy}
        onClick={onClick}
        className="relative p-2 rounded-xl inline-flex size-11 items-center justify-center transition-colors hover:bg-[var(--color-surface-light)]"
      >
        <BellIcon className="size-6" />
      </button>
      {unread > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
          {unread >= 10 ? '9+' : unread}
        </span>
      )}
    </span>
  )
}

const said = (n: number) =>
  n === 0 ? 'Aucune notification non lue' : n === 1 ? '1 notification non lue' : n < 10 ? `${n} notifications non lues` : 'Plus de 9 notifications non lues'

export function Bell() {
  const store = unreadStore()
  // Rendu serveur : 0, sans abonnement ni client Supabase (P14).
  const unread = useSyncExternalStore(store.subscribe, store.get, () => 0)
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <>
      <BellButton unread={unread} onClick={() => setOpen(true)} describedBy={id} />
      <span id={id} className="sr-only">{said(unread)}</span>
      {open && <NotificationPanel onClose={() => setOpen(false)} />}
    </>
  )
}
