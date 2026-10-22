'use client'

import { useSyncExternalStore } from 'react'
import { serverNow, subscribeClock } from '@/lib/clock'
import { formatRemaining } from '@/lib/format'

// Compte à rebours sur end_at absolu, corrigé par l'horloge du serveur (D§7.0) ; le texte ne change qu'une fois par seconde.
// over : enchère qui n'est plus active, même avant end_at (une vente retirée garde son end_at futur, wm.cancel_auction).
// Rendu serveur (troisième argument, comme PackStock.tsx) : « Terminée » si over, sinon rien, l'heure n'existant qu'au client.
export function Countdown({ endAt, over = false }: { endAt: string; over?: boolean }) {
  const left = useSyncExternalStore(subscribeClock, () => {
    const ms = Date.parse(endAt) - serverNow()
    return over || ms <= 0 ? 'Terminée' : formatRemaining(ms)
  }, () => (over ? 'Terminée' : null))
  return <time dateTime={endAt} className="text-amber-600 tabular-nums">{left}</time>
}
