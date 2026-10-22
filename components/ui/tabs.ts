import type { KeyboardEvent } from 'react'

// Clavier d'une liste d'onglets (celui de CardModal.tsx) : flèches (en boucle), Début et Fin ; l'onglet suit le focus. Ids : `${id}-tab-${t}`.
export function tabKey<T extends string>(e: KeyboardEvent, tabs: readonly T[], tab: T, id: string, set: (t: T) => void) {
  const i = tabs.indexOf(tab)
  const j = ({ ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 } as Record<string, number>)[e.key]
  if (j === undefined) return
  e.preventDefault()
  const next = tabs[(j + tabs.length) % tabs.length]
  set(next)
  document.getElementById(`${id}-tab-${next}`)?.focus()
}
