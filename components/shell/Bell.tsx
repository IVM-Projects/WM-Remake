import { Bell as BellIcon } from 'lucide-react'

// `aria-label="Notifications"` est un sélecteur d'extension (R§6.8) ; le panneau arrive avec les notifications (M4).
// shortcut: le nombre de non-lus n'est pas annoncé (le nom accessible est figé), le relier par aria-describedby avec le panneau.
export function Bell({ unread = 0 }: { unread?: number }) {
  return (
    <button
      type="button"
      aria-label="Notifications"
      className="relative p-2 rounded-xl inline-flex size-11 items-center justify-center transition-colors hover:bg-[var(--color-surface-light)]"
    >
      <BellIcon className="size-6" />
      {unread > 0 && (
        <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  )
}
