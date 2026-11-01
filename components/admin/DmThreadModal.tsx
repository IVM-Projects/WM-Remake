'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ghost, primary } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { api, apiOnce } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { actionError, ActionModal } from './ActionModal'
import { ReasonField } from './ReasonField'
import type { DmMessage, Who } from './types'

const name = (w: Who) => w.username ?? 'Joueur supprimé'

// Messages privés d'une paire signalée (G9). La lecture est auditée : dite avant, motif d'abord. Supprimer un message ne relit pas le fil (une relecture
// serait une seconde lecture auditée) : il quitte la liste locale. La confirmation est une modale sœur, pas fille : Échap et Tab vont à la plus récente.
export function DmThreadModal({ a, b, keys, onClose }: { a: Who; b: Who; keys: Map<string, string>; onClose: () => void }) {
  const id = useId()
  const [reason, setReason] = useState('')
  const [messages, setMessages] = useState<DmMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [doomed, setDoomed] = useState<DmMessage | null>(null)
  const inflight = useRef(false)
  const log = useRef<HTMLDivElement>(null)
  const empty = useRef<HTMLParagraphElement>(null)
  // Message supprimé : le focus va à l'action du suivant (ou au texte du vide), une fois la liste rendue.
  const next = useRef<number | null>(null)
  const ready = reason.trim().length >= 3 && reason.length <= 500
  const label = `Messages entre ${name(a)} et ${name(b)}`

  async function read(e: FormEvent) {
    e.preventDefault()
    if (inflight.current || !ready) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ messages?: DmMessage[] } | null>('/api/admin/dm-thread', {
        method: 'POST',
        body: JSON.stringify({ user_a: a.id, user_b: b.id, reason: reason.trim() }),
      })
      if (!Array.isArray(r?.messages)) setError('La lecture n\'a pas pu être confirmée : elle a peut-être été enregistrée au journal. Réessaie.')
      else setMessages(r.messages)
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

  useEffect(() => {
    if (next.current === null || !messages) return
    const buttons = log.current?.querySelectorAll<HTMLElement>('button')
    ;(buttons?.length ? buttons[Math.min(next.current, buttons.length - 1)] : empty.current)?.focus()
    next.current = null
  }, [messages])

  return (
    <>
      <Modal onClose={close} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-2xl animate-fade-in-up space-y-4 p-6 max-h-[90vh] overflow-y-auto">
        <h2 id={`${id}-title`} className="text-xl font-bold wrap-anywhere">{label}</h2>
        {messages ? (
          <>
            {messages.length ? (
              <div ref={log} role="log" aria-label={label} tabIndex={0} className="max-h-[50vh] space-y-3 overflow-y-auto">
                {messages.map((m, i) => (
                  <div key={m.id} className="card-frame space-y-1 p-3">
                    <p className="text-sm font-semibold wrap-anywhere">{m.sender_username ?? 'Joueur supprimé'}</p>
                    <time dateTime={m.created_at} className="block text-xs text-[var(--color-foreground)]/70">{formatDateTime(m.created_at)}</time>
                    <p className="text-sm whitespace-pre-wrap wrap-anywhere">{m.content}</p>
                    <button type="button" onClick={() => { next.current = i; setDoomed(m) }} className={ghost}>Supprimer</button>
                  </div>
                ))}
              </div>
            ) : (
              <p ref={empty} tabIndex={-1} className="card-frame p-6 text-center text-sm outline-none">Aucun message entre ces deux joueurs.</p>
            )}
            <div className="flex justify-end"><button type="button" onClick={close} className={ghost}>Fermer</button></div>
          </>
        ) : (
          <form onSubmit={read} className="space-y-4">
            <p id={`${id}-audit`} className="text-sm">Cette lecture est enregistrée au journal avec ton motif.</p>
            <ReasonField value={reason} onChange={(v) => { setReason(v); setError(null) }} describedBy={`${id}-audit`} />
            {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="submit" aria-disabled={!ready || busy || undefined} className={primary}>Lire les messages</button>
              <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
            </div>
          </form>
        )}
      </Modal>
      {doomed && (
        <ActionModal
          title="Supprimer ce message ?"
          consequence="Le message disparaît pour les deux joueurs."
          action="Supprimer"
          tone="danger"
          onClose={() => { next.current = null; setDoomed(null) }}
          onConfirm={async (r) => {
            const res = await apiOnce<{ ok?: boolean } | null>(keys, `dm-delete:${doomed.id}:${r}`, `/api/admin/dms/${doomed.id}`, {
              method: 'DELETE', body: JSON.stringify({ reason: r }),
            })
            if (!res) throw new Error('unreadable')
            toast('Message supprimé.')
            setMessages((all) => all?.filter((m) => m.id !== doomed.id) ?? all)
            setDoomed(null)
          }}
        />
      )}
    </>
  )
}
