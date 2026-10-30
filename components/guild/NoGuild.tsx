'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ghost, primary } from '@/components/ui/button'
import { Section } from '@/components/ui/Section'
import { apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatShortDate } from '@/lib/format'
import { isGuildState, type GuildInvite, type GuildState } from './types'

const field = 'w-full min-h-11 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2 text-sm read-only:opacity-80'
const counter = 'text-xs text-[var(--color-foreground)]/70'

// Vue sans guilde : invitations reçues (Rejoindre, Refuser) et formulaire de création. Une écriture à la fois (aria-disabled, jamais disabled) ;
// une issue incertaine garde sa clé (apiOnce) et relit la guilde (onRead). Un succès rend l'état tel quel (onState).
export function NoGuild({ invites, onState, onRead }: { invites: GuildInvite[]; onState: (s: GuildState) => void; onRead: () => Promise<void> }) {
  const id = useId()
  const keys = useRef(new Map<string, string>())
  const inflight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<{ guild: string; text: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const list = useRef<HTMLUListElement>(null)
  const empty = useRef<HTMLParagraphElement>(null)
  // Rang de l'invitation refusée : le focus passe à « Rejoindre » de celle qui prend sa place, sinon à l'état vide.
  const refocus = useRef<number | null>(null)

  useEffect(() => {
    const i = refocus.current
    if (i === null) return
    refocus.current = null
    if (document.activeElement !== document.body) return
    const joins = list.current?.querySelectorAll<HTMLElement>('[data-join]')
    ;(joins?.[Math.min(i, joins.length - 1)] ?? empty.current)?.focus()
  }, [invites])

  async function write(intent: string, path: string, init: RequestInit, onFail: (text: string) => void, after?: () => void) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setRowError(null)
    setFormError(null)
    try {
      const r = await apiOnce<unknown>(keys.current, intent, path, init)
      if (isGuildState(r)) onState(r)
      else await onRead()
      after?.()
    } catch (e) {
      onFail(unsure(e) ? UNSURE : userMessage(e, 'L\'action n\'a pas abouti.'))
      void onRead()
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const join = (g: GuildInvite) => write(`join:${g.guild_id}`, '/api/guilds/join', { method: 'POST', body: JSON.stringify({ guild_id: g.guild_id }) },
    (text) => setRowError({ guild: g.guild_id, text }))
  const decline = (g: GuildInvite, i: number) => write(`decline:${g.guild_id}`, `/api/guilds/invites/${g.guild_id}`, { method: 'DELETE' },
    (text) => setRowError({ guild: g.guild_id, text }), () => { refocus.current = i })

  function create(e: FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    const d = description.trim()
    // La clé suit le texte envoyé : un texte modifié après une issue incertaine est une autre intention.
    void write(`create:${n}\n${d}`, '/api/guilds', { method: 'POST', body: JSON.stringify({ name: n, ...(d && { description: d }) }) }, setFormError)
  }

  return (
    <div className="space-y-6">
      <div className="card-frame space-y-1 p-6 text-sm">
        <p className="font-semibold">Tu n&apos;as pas encore de guilde.</p>
        <p>Pour en rejoindre une, demande à un ami membre de t&apos;inviter.</p>
      </div>

      <Section id={`${id}-invites`} title="Invitations">
        {invites.length ? (
          <ul ref={list} className="divide-y divide-[var(--color-border)]">
            {invites.map((g, i) => {
              const who = `${id}-guild-${g.guild_id}`
              return (
                <li key={g.guild_id} className="space-y-1 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <div className="min-w-0">
                      <p id={who} className="font-semibold wrap-anywhere">{g.guild_name}</p>
                      <p className="text-sm text-[var(--color-foreground)]/70 wrap-anywhere">
                        {`Invitation de ${g.inviter_username} · `}<time dateTime={g.created_at}>{formatShortDate(g.created_at)}</time>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" data-join="" aria-disabled={busy || undefined} aria-describedby={who} onClick={() => void join(g)} className={primary}>Rejoindre</button>
                      <button type="button" aria-disabled={busy || undefined} aria-describedby={who} onClick={() => void decline(g, i)} className={ghost}>Refuser</button>
                    </div>
                  </div>
                  {rowError?.guild === g.guild_id && <p role="alert" className="text-sm font-medium text-red-400">{rowError.text}</p>}
                </li>
              )
            })}
          </ul>
        ) : (
          <p ref={empty} tabIndex={-1} className="text-sm outline-none">Aucune invitation.</p>
        )}
      </Section>

      <Section id={`${id}-create`} title="Créer une guilde">
        <form onSubmit={create} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">Nom de la guilde</label>
            <input id={`${id}-name`} value={name} maxLength={40} readOnly={busy} aria-describedby={`${id}-name-n`} onChange={(e) => setName(e.target.value)} className={field} />
            <p id={`${id}-name-n`} className={counter}>{`${name.length} / 40`}</p>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-desc`} className="text-sm font-medium">Description (facultatif)</label>
            <textarea id={`${id}-desc`} value={description} maxLength={280} rows={3} readOnly={busy} aria-describedby={`${id}-desc-n`} onChange={(e) => setDescription(e.target.value)} className={field} />
            <p id={`${id}-desc-n`} className={counter}>{`${description.length} / 280`}</p>
          </div>
          <button type="submit" aria-disabled={busy || !name.trim() || undefined} className={primary}>Créer la guilde</button>
          {formError && <p role="alert" className="text-sm font-medium text-red-400">{formError}</p>}
        </form>
      </Section>
    </div>
  )
}
