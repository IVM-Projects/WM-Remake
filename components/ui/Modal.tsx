'use client'

import { useEffect, useEffectEvent, useRef, type FocusEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

// Modales ouvertes, la plus récente en dernier : seule celle-ci prend Échap et Tab (une confirmation ouverte sur une autre modale).
const open: HTMLElement[] = []

// Nom de la boîte : labelledBy (id d'un titre), ou label quand la page n'a aucun id d'élément (détail d'une enchère, M3-2).
type Props = { onClose: () => void; labelledBy?: string; label?: string; className: string; children: ReactNode }

// Portail div.fixed.inset-0 de l'original (R§6.3), mais en role="dialog" avec piège de focus et Échap (D§8.6).
// Le panneau (className) est l'élément dialog : c'est lui qui porte card-frame dans la modale de carte.
export function Modal({ onClose, labelledBy, label, className, children }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const downOnBackdrop = useRef(false)
  // Une fois par montage : réaffichée par Activity, la modale ne prend pas pour ouvreur le lien de navigation cliqué entre-temps.
  const opener = useRef<HTMLElement | null>(null)

  // Sur document : Échap et Tab marchent même si le focus est tombé sur body. Un enfant garde Échap par preventDefault (liste d'étiquettes ouverte).
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    const root = panel.current
    if (e.defaultPrevented || !root || open.at(-1) !== root) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    // Tabulables seulement : un bouton en tabindex=-1 (onglet inactif, option de liste) en bout de liste laisserait filer Tab.
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0)
    const [first, last] = [items[0], items[items.length - 1]]
    const active = document.activeElement
    const edge = e.shiftKey ? active === first || active === root : active === last
    if (!first || edge || !root.contains(active)) {
      e.preventDefault()
      ;((e.shiftKey ? last : first) ?? root).focus()
    }
  })

  // Focus sur le panneau à l'ouverture, rendu à l'élément d'origine à la fermeture.
  useEffect(() => {
    opener.current ??= document.activeElement as HTMLElement | null
    panel.current?.focus()
    const mine = panel.current
    if (mine) open.push(mine)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const i = mine ? open.indexOf(mine) : -1
      if (i >= 0) open.splice(i, 1)
      document.removeEventListener('keydown', onKeyDown)
      opener.current?.focus()
    }
  }, [])

  // Bouton désactivé ou retiré sous le focus : le navigateur le pose sur body ; on le ramène dans la modale.
  // Le focus parti vers une autre fenêtre reste sur l'élément (activeElement inchangé) : rien à faire alors.
  const onBlur = (e: FocusEvent) => {
    if (e.relatedTarget) return
    setTimeout(() => {
      if (document.activeElement === document.body) panel.current?.focus()
    })
  }

  const overlay = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      // Un glisser commencé dans le panneau (sélection de texte) et relâché sur le voile ne ferme pas.
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
        onBlur={onBlur}
        className={`${className} outline-none`}
      >
        {children}
      </div>
    </div>
  )
  // shortcut: rendu en place sans document (tests renderToStaticMarkup) ; une modale ouverte dès le rendu serveur divergerait à l'hydratation, l'ouvrir après montage.
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}
