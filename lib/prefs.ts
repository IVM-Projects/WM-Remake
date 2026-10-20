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
    api<{ sounds: boolean; hide_sensitive: boolean }>('/api/settings/preferences').then(
      (p) => {
        state = { sounds: p.sounds, hideSensitive: p.hide_sensitive, ready: true }
        listeners.forEach((l) => l())
      },
      // Échec : on reste en mode prudent, le prochain montage réessaie.
      () => { loading = false },
    )
  }
  return () => { listeners.delete(listener) }
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => state, () => LOADING)
}
