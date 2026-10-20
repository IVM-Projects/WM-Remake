'use client'

import { useSyncExternalStore } from 'react'

// false au rendu serveur et à l'hydratation, true ensuite : un envoi natif du HTML statique (GET, mot de passe dans l'adresse) est impossible.
const noop = () => () => {}
export const useHydrated = () => useSyncExternalStore(noop, () => true, () => false)

// disabled natif jusqu'à l'hydratation seulement (aucun focus possible avant) ; ensuite aria-disabled et la garde du submit
// de l'appelant : un bouton pressé n'est jamais disabled sous le focus (le navigateur le poserait sur body).
export function Submit({ children, off }: { children: string; off: boolean }) {
  return (
    <button
      type="submit"
      disabled={!useHydrated()}
      aria-disabled={off}
      className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-light disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
    >
      {children}
    </button>
  )
}
