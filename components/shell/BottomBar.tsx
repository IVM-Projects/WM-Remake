'use client'

import { Ellipsis, X } from 'lucide-react'
import { useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { MOBILE_NAV, MORE_NAV } from './nav'
import { NavLink } from './NavLink'

// Libellés à 11 px, comme une barre d'onglets native : « Collection » tient encore à 320 px de large.
const barItem = 'flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-1.5 text-[11px] font-medium transition-colors'

// <dialog> natif ouvert par showModal() : role dialog, reste de la page inerte, Échap ferme et rend le focus au bouton.
export function BottomBar() {
  const sheet = useRef<HTMLDialogElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  // Clic sur le voile (cible = le dialog lui-même) ou sur un lien (navigation client, la barre reste montée).
  const closeOnClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget || (e.target as Element).closest('a')) e.currentTarget.close()
  }
  // Le dialog modal rend la page inerte mais laisse Tab filer vers le navigateur : on boucle sur la feuille.
  const trapTab = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab') return
    const items = e.currentTarget.querySelectorAll<HTMLElement>('a, button')
    const [first, last] = [items[0], items[items.length - 1]]
    if (document.activeElement === (e.shiftKey ? first : last)) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    }
  }
  return (
    <>
      {/* Classes de la barre basse d'origine (R§6.3) : contrat, ne pas renommer. */}
      <nav
        aria-label="Navigation principale"
        className="md:hidden order-last z-50 bg-[var(--color-surface)]/95 backdrop-blur-md border-t border-[var(--color-border)] pb-[calc(6px+env(safe-area-inset-bottom,0px))]"
      >
        <div className="grid grid-cols-5 gap-0.5 px-1 pt-1.5">
          {MOBILE_NAV.map(({ href, label, icon: Icon }) => (
            <NavLink key={href} href={href} className={barItem}>
              <Icon className="size-6 shrink-0" />
              <span className="max-w-full truncate">{label}</span>
            </NavLink>
          ))}
          <button
            ref={more}
            type="button"
            aria-haspopup="dialog"
            onClick={() => sheet.current?.showModal()}
            className={`${barItem} hover:bg-[var(--color-surface-light)]`}
          >
            <Ellipsis className="size-6 shrink-0" />
            <span className="max-w-full truncate">Plus</span>
          </button>
        </div>
      </nav>
      <dialog
        ref={sheet}
        aria-modal="true"
        aria-labelledby="more-sheet-title"
        onClick={closeOnClick}
        onKeyDown={trapTab}
        // Safari et Firefox macOS ne focalisent pas un bouton cliqué : le focus rendu par le navigateur irait sur body.
        onClose={() => more.current?.focus()}
        className="mx-0 mt-auto mb-0 max-h-[85dvh] w-full max-w-full rounded-t-2xl border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] backdrop:bg-black/70 backdrop:backdrop-blur-sm motion-safe:animate-fade-in-up"
      >
        <div className="p-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          <div className="mb-2 flex items-center justify-between gap-4">
            <h2 id="more-sheet-title" className="px-4 text-lg font-bold">Plus</h2>
            <button
              type="button"
              // Pas « Fermer » seul : c'est le sélecteur d'extension du bouton de la modale de carte (R§6.8).
              aria-label="Fermer le menu"
              onClick={() => sheet.current?.close()}
              className="inline-flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-light)]"
            >
              <X className="size-6" />
            </button>
          </div>
          <div className="grid gap-1">
            {MORE_NAV.map(({ href, label, icon: Icon }) => (
              <NavLink key={href} href={href} className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors">
                <Icon className="size-5 shrink-0" />
                {label}
              </NavLink>
            ))}
          </div>
        </div>
      </dialog>
    </>
  )
}
