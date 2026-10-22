'use client'

import { useSyncExternalStore } from 'react'
import { serverNow, subscribeClock } from '@/lib/clock'
import { formatRemaining } from '@/lib/format'

// Compte à rebours sur end_at absolu, corrigé par l'horloge du serveur (D§7.0) ; le texte ne change qu'une fois par seconde.
// Sans valeur au rendu serveur (troisième argument, comme PackStock.tsx) : l'heure n'existe qu'au client.
export function Countdown({ endAt }: { endAt: string }) {
  const left = useSyncExternalStore(subscribeClock, () => {
    const ms = Date.parse(endAt) - serverNow()
    return ms > 0 ? formatRemaining(ms) : 'Terminée'
  }, () => null)
  return <time dateTime={endAt} className="text-amber-600 tabular-nums">{left}</time>
}
