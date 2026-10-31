'use client'

import { useId, useState } from 'react'
import { apiOnce } from '@/lib/api'
import { toast } from '@/components/ui/toast'
import { ActionModal } from './ActionModal'
import type { Sanctioned, StaffRole } from './types'

const KINDS = [['warning', 'Avertissement'], ['restriction', 'Restriction'], ['suspension', 'Suspension'], ['ban', 'Bannissement']] as const
type Kind = (typeof KINDS)[number][0]
const CONSEQUENCE: Record<Kind, string> = {
  warning: 'Aucun effet sur le compte, l\'avertissement reste dans sa fiche.',
  restriction: 'Le joueur ne peut plus agir dans le jeu jusqu\'à la fin, il peut encore consulter.',
  suspension: 'Le joueur ne peut plus ni agir ni consulter, sa session est coupée jusqu\'à la fin.',
  ban: 'Le joueur ne peut plus ni agir ni consulter, sa session est coupée sans fin.',
}
const DAY = 86_400_000
// Valeur d'un input datetime-local (heure locale, à la minute).
const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

// Sanction d'un joueur, depuis sa fiche ou un signalement (reportId : la revue passe à « traité »). Suspension et bannissement : administrateurs seulement
// (l'API le vérifie aussi). onDone reçoit la réponse (auth_synced) ; réussi, l'appelant ferme la modale.
export function SanctionModal({ user, role, reportId, keys, onDone, onClose }: {
  user: { id: string; username: string }
  role: StaffRole
  reportId?: string
  keys: Map<string, string>
  onDone: (res: Sanctioned) => void
  onClose: () => void
}) {
  const id = useId()
  const [kind, setKind] = useState<Kind>('warning')
  const [end, setEnd] = useState('')
  // Bornes figées à l'ouverture : « un an au plus » côté serveur, une minute de marge.
  const [bounds] = useState(() => ({ min: Date.now(), max: Date.now() + 365 * DAY - 60_000 }))
  const dated = kind === 'restriction' || kind === 'suspension'
  const at = Date.parse(end)
  const valid = !dated || (Number.isFinite(at) && at > bounds.min && at <= bounds.max)

  return (
    <ActionModal
      title={`Sanctionner ${user.username}`}
      consequence={CONSEQUENCE[kind]}
      action="Sanctionner"
      tone="danger"
      valid={valid}
      onClose={onClose}
      onConfirm={async (reason) => {
        const body = JSON.stringify({ kind, reason, ...(dated ? { ends_at: new Date(at).toISOString() } : {}), ...(reportId ? { report_id: reportId } : {}) })
        const res = await apiOnce<Sanctioned | null>(keys, `sanction:${user.id}:${body}`, `/api/admin/users/${user.id}/sanctions`, { method: 'POST', body })
        if (!res) throw new Error('unreadable')
        toast('Sanction enregistrée.')
        onDone(res)
      }}
    >
      <fieldset className="space-y-1">
        <legend className="text-sm font-semibold">Type</legend>
        {KINDS.filter(([k]) => role === 'admin' || k === 'warning' || k === 'restriction').map(([k, label]) => (
          <label key={k} className="flex min-h-11 items-center gap-3 text-sm">
            <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} className="size-5 accent-[var(--color-accent)]" />
            {label}
          </label>
        ))}
      </fieldset>
      {dated && (
        <div className="space-y-1">
          <label htmlFor={`${id}-end`} className="text-sm font-semibold">Fin</label>
          <input
            id={`${id}-end`}
            type="datetime-local"
            required
            value={end}
            min={local(bounds.min)}
            max={local(bounds.max)}
            onChange={(e) => setEnd(e.target.value)}
            className="block min-h-11 w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm"
          />
        </div>
      )}
    </ActionModal>
  )
}
