'use client'

import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from 'react'
import { ghost, primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { api, apiOnce, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'

// Motifs du D (enum report_reason, M4b-10), dans l'ordre affiché.
const REASONS = [['cheating', 'Triche'], ['inappropriate_content', 'Contenu inapproprié'], ['spam', 'Spam']] as const
type Reason = (typeof REASONS)[number][0]
type Report = { reason: Reason; details: string | null }
// Réponse perdue, 5xx ou corps illisible (B12) : relancé avec le même corps, l'envoi garde sa clé (apiOnce) et le serveur rejoue sa réponse.
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'

// Signalement d'un joueur (M4b-24) : un par couple, prérempli par le sien à l'ouverture, modifiable.
export function ReportModal({ user, onClose }: { user: { id: string; username: string }; onClose: () => void }) {
  const id = useId()
  // undefined : pas encore lu ; null : aucun signalement.
  const [report, setReport] = useState<Report | null>()
  const [failed, setFailed] = useState(false)
  const [reason, setReason] = useState<Reason | null>(null)
  const [details, setDetails] = useState('')
  // Refus ou issue incertaine du dernier envoi, effacé dès que le formulaire change (un autre corps, une autre intention).
  const [error, setError] = useState<string | null>(null)
  // Un envoi à la fois, formulaire figé : aria-disabled, readOnly et gardes, jamais disabled.
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const title = useRef<HTMLHeadingElement>(null)
  const started = useRef(false)

  // 2xx sans clé `report` (corps illisible : api() rend null) : une lecture en échec.
  const load = () => api<{ report?: Report | null } | null>(`/api/reports?reportedUserId=${user.id}`).then((r) => {
    if (r?.report === undefined) return setFailed(true)
    setReport(r.report)
    setReason(r.report?.reason ?? null)
    setDetails(r.report?.details ?? '')
  }, () => setFailed(true))
  // Lu une fois, à l'ouverture : réaffichée par Activity, la modale garde ce que le joueur a saisi.
  const onOpen = useEffectEvent(() => {
    if (started.current) return
    started.current = true
    void load()
  })
  useEffect(() => onOpen(), [])

  // Échap, voile ou « Annuler », jamais pendant l'envoi.
  const close = () => {
    if (!inflight.current) onClose()
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    if (inflight.current || !reason) return
    // details omis quand il est vide, jamais null (la route refuse null, ruling Task 8 → 11).
    const body = JSON.stringify({ reportedUserId: user.id, reason, ...(details ? { details } : {}) })
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await apiOnce<{ report: Report } | null>(keys.current, body, '/api/reports', { method: 'POST', body })
      if (!r?.report) return setError(UNSURE)
      toast(report ? 'Signalement modifié.' : 'Signalement envoyé.')
      // Démontée, la modale rend le focus à « Signaler ».
      onClose()
    } catch (err) {
      setError(userMessage(err, unsure(err) ? UNSURE : 'L\'action n\'a pas abouti.'))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal onClose={close} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-md animate-fade-in-up space-y-4 p-6 max-h-[90vh] overflow-y-auto">
      <h2 ref={title} id={`${id}-title`} tabIndex={-1} className="text-xl font-bold outline-none wrap-anywhere">{`Signaler ${user.username}`}</h2>
      {failed ? (
        // « Réessayer » disparaît pendant la relecture : le focus passe au titre, jamais sur body.
        <LoadError onRetry={() => {
          title.current?.focus()
          setFailed(false)
          void load()
        }} />
      ) : report === undefined ? (
        <Loading label="Chargement du signalement" />
      ) : (
        <form onSubmit={send} className="space-y-4">
          <p className="text-sm text-[var(--color-foreground)]/70">Un seul signalement par joueur : tu peux le modifier.</p>
          {/* Radios natives de même name : un seul arrêt de tabulation, les flèches pour choisir. */}
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold">Motif</legend>
            {REASONS.map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="reason"
                  value={value}
                  checked={reason === value}
                  // Garde pendant l'envoi : une radio n'a pas de readOnly.
                  onChange={() => {
                    if (inflight.current) return
                    setReason(value)
                    setError(null)
                  }}
                  className="size-5 accent-[var(--color-accent)]"
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="space-y-1">
            <label htmlFor={`${id}-details`} className="text-sm font-semibold">Détails (facultatif)</label>
            <textarea
              id={`${id}-details`}
              value={details}
              maxLength={500}
              rows={4}
              readOnly={busy}
              aria-describedby={`${id}-count`}
              onChange={(e) => {
                setDetails(e.target.value)
                setError(null)
              }}
              className="block w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm"
            />
            <p id={`${id}-count`} className="text-right text-xs tabular-nums text-[var(--color-foreground)]/70">{`${formatInt(details.length)} / 500`}</p>
          </div>
          {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="submit" aria-disabled={!reason || busy || undefined} className={primary}>
              {report ? 'Modifier le signalement' : 'Envoyer le signalement'}
            </button>
            <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
          </div>
        </form>
      )}
    </Modal>
  )
}
