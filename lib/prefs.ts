'use client'

import { useSyncExternalStore } from 'react'
import { api } from './api'

export type Prefs = { sounds: boolean; hideSensitive: boolean; ready: boolean }

// Tant que la lecture n'est pas finie : images sensibles masquées et aucun son.
const LOADING: Prefs = { sounds: false, hideSensitive: true, ready: false }
let state = LOADING
let loading = false
const listeners = new Set<() => void>()

// Cache de module : une seule lecture par chargement de page, partagée par toutes les cartes.
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!state.ready && !loading) {
    loading = true
    api<{ sounds?: unknown; hide_sensitive?: unknown } | null>('/api/settings/preferences')
      .then((p) => {
        if (typeof p?.sounds !== 'boolean' || typeof p.hide_sensitive !== 'boolean') throw new Error('préférences illisibles')
        state = { sounds: p.sounds, hideSensitive: p.hide_sensitive, ready: true }
        listeners.forEach((l) => l())
      })
      // Échec ou corps inattendu : on reste en mode prudent, le prochain montage réessaie.
      .catch(() => { loading = false })
  }
  return () => { listeners.delete(listener) }
}

// Hors React (lib/sounds.ts) : l'état courant, prudent tant que la lecture n'est pas finie.
export const currentPrefs = (): Prefs => state

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => state, () => LOADING)
}
