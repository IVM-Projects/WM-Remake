'use client'

import { Lock, Sparkles } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { api, calendarTz } from '@/lib/api'

type Status = { eligible: boolean; claimed_today: boolean; size?: number; is_pro: boolean; next_claim_at?: string | null }

// Bloc « Paquet PRO du jour » (R§2.2, R§5.1). Relu à chaque montage : PullsClient le remonte au retour d'une révélation.
export function ProDailyBlock({ busy, onClaim }: { busy: boolean; onClaim: () => void }) {
  const id = useId()
  const [status, setStatus] = useState<Status | 'error' | null>(null)

  useEffect(() => {
    let live = true
    api<Status>('/api/packs/pro-daily', { headers: calendarTz() }).then(
      (s) => { if (live) setStatus(s) },
      () => { if (live) setStatus('error') },
    )
    return () => { live = false }
  }, [])

  const s = status === 'error' ? null : status
  const nextDate = s?.next_claim_at ? new Date(s.next_claim_at) : null
  const next = nextDate && `${nextDate.toDateString() === new Date().toDateString() ? '' : 'demain '}à\u00a0${nextDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`

  return (
    <section aria-labelledby={id} aria-busy={status === null} className="card-frame w-full max-w-sm space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={id} className="inline-flex items-center gap-2 text-base font-bold">
            <Sparkles className="size-4 text-violet-300" />
            Paquet PRO du jour
          </h2>
          <p className="text-sm text-[var(--color-foreground)]/70">{s?.size ?? 15} cartes, aucune commune, une fois par jour.</p>
        </div>
        {s?.is_pro && s.eligible && (
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={onClaim}
            className="min-h-11 shrink-0 rounded-xl bg-violet-500/20 px-4 text-sm font-semibold text-violet-200 transition-colors hover:bg-violet-500/30 aria-disabled:cursor-progress aria-disabled:opacity-80"
          >
            {busy ? 'Récupération…' : 'Récupérer'}
          </button>
        )}
        <span role="status" className="sr-only">{busy ? 'Récupération du paquet Pro…' : ''}</span>
      </div>
      {status === 'error' && <p className="text-sm text-[var(--color-foreground)]/70">Le paquet du jour n&apos;a pas pu être lu.</p>}
      {s && !s.is_pro && (
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-violet-300">
          <Lock className="size-3.5" />
          Réservé aux membres Pro
        </p>
      )}
      {s?.is_pro && !s.eligible && (
        <p className="text-sm text-[var(--color-foreground)]/70">
          Déjà récupéré{s.claimed_today && ' aujourd\'hui'}{next && `, reviens ${next}`}.
        </p>
      )}
    </section>
  )
}
