'use client'

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

type Props = { onClose: () => void; labelledBy: string; className: string; children: ReactNode }

// Portail div.fixed.inset-0 de l'original (R§6.3), mais en role="dialog" avec piège de focus et Échap (D§8.6).
// Le panneau (className) est l'élément dialog : c'est lui qui porte card-frame dans la modale de carte.
export function Modal({ onClose, labelledBy, className, children }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const downOnBackdrop = useRef(false)

  // Focus sur le panneau à l'ouverture, rendu à l'élément d'origine à la fermeture.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => opener?.focus()
  }, [])

  // Événements React : un enfant (liste d'étiquettes ouverte) peut garder Échap pour lui par stopPropagation.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !panel.current) return
    // Tabulables seulement : un bouton en tabindex=-1 (onglet inactif, option de liste) en bout de liste laisserait filer Tab.
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0)
    const [first, last] = [items[0], items[items.length - 1]]
    const active = document.activeElement
    if (!first || (e.shiftKey ? active === first || active === panel.current : active === last)) {
      e.preventDefault()
      ;(e.shiftKey ? last : first)?.focus()
    }
  }

  const overlay = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onKeyDown={onKeyDown}
      // Un glisser commencé dans le panneau (sélection de texte) et relâché sur le voile ne ferme pas.
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose() }}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} className={`${className} outline-none`}>
        {children}
      </div>
    </div>
  )
  // shortcut: rendu en place sans document (tests renderToStaticMarkup) ; une modale ouverte dès le rendu serveur divergerait à l'hydratation, l'ouvrir après montage.
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}
