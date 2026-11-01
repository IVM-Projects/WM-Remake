'use client'

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { danger, ghost, primary } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { ApiError, UNSURE, unsure, userMessage } from '@/lib/api'
import { ReasonField } from './ReasonField'

// Texte d'un refus (français, de la route) ou d'une issue incertaine ; tout ce qui n'est pas une réponse du serveur (réseau, corps illisible) est incertain.
export const actionError = (e: unknown): string => (e instanceof ApiError ? userMessage(e, unsure(e) ? UNSURE : 'L\'action n\'a pas abouti.') : UNSURE)

// Confirmation d'une action du staff : conséquence en une ligne, motif obligatoire (3 à 500 caractères), bouton d'action en aria-disabled tant que
// le motif ou `valid` manque. onConfirm(reason) lève l'échec, montré en alerte ; réussi, l'appelant ferme la modale. children : champs en plus.
export function ActionModal({ title, consequence, action, tone, valid = true, children, onConfirm, onClose }: {
  title: string
  consequence: string
  action: string
  tone: 'danger' | 'primary'
  valid?: boolean
  children?: ReactNode
  onConfirm: (reason: string) => Promise<void>
  onClose: () => void
}) {
  const id = useId()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Un envoi à la fois : aria-disabled et garde, ni Échap, ni voile, ni « Annuler » pendant la requête.
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const ready = valid && reason.trim().length >= 3 && reason.length <= 500

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (inflight.current || !ready) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      await onConfirm(reason.trim())
    } catch (err) {
      setError(actionError(err))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }
  const close = () => {
    if (!inflight.current) onClose()
  }

  return (
    <Modal onClose={close} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-md animate-fade-in-up space-y-4 p-6 max-h-[90vh] overflow-y-auto">
      <h2 id={`${id}-title`} className="text-xl font-bold wrap-anywhere">{title}</h2>
      <form onSubmit={submit} className="space-y-4">
        {children}
        <p id={`${id}-consequence`} className="text-sm">{consequence}</p>
        <ReasonField value={reason} onChange={(v) => { setReason(v); setError(null) }} describedBy={`${id}-consequence`} />
        {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="submit" aria-disabled={!ready || busy || undefined} className={tone === 'danger' ? danger : primary}>{action}</button>
          <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
        </div>
      </form>
    </Modal>
  )
}
