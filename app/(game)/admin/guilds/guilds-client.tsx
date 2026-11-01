'use client'

import { Shield } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from 'react'
import { ActionModal } from '@/components/admin/ActionModal'
import type { GuildDetail, GuildHit, StaffRole } from '@/components/admin/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { link, ghost } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { toast } from '@/components/ui/toast'
import { api, apiOnce } from '@/lib/api'
import { formatDateTime, formatInt, formatShortDate } from '@/lib/format'

const FIELD = 'block min-h-11 w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'
type Modal = 'dissolve' | { message: GuildDetail['messages'][number] } | { wish: GuildDetail['wishes'][number] }

const readableDetail = (d: GuildDetail | null): GuildDetail | null =>
  d && d.guild && typeof d.guild.name === 'string' && Array.isArray(d.members) && Array.isArray(d.messages) && Array.isArray(d.wishes) ? d : null

// /admin/guilds : recherche par fragment du nom (Entrée), fiche de la guilde choisie (?guild=<id>), messages et demandes retirés, dissolution (administrateurs).
export function GuildsClient({ role }: { role: StaffRole }) {
  const id = useId()
  const router = useRouter()
  const guildId = useSearchParams().get('guild') || null
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [found, setFound] = useState<GuildHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [detail, setDetail] = useState<GuildDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [settled, setSettled] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  const [typed, setTyped] = useState('')
  const searchGen = useRef(0)
  const detailGen = useRef(0)
  const [keys] = useState(() => new Map<string, string>())
  const lastQuery = useRef('')
  const input = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const results = useRef<HTMLHeadingElement>(null)
  const retrySearch = useRef<HTMLButtonElement>(null)
  const retryDetail = useRef<HTMLButtonElement>(null)
  const focusAfter = useRef<'search' | 'detail' | 'input' | null>(null)

  const search = (q: string) => {
    const g = ++searchGen.current
    setSearching(true)
    setSearchFailed(false)
    return api<{ guilds?: GuildHit[] } | null>(`/api/admin/guilds?${new URLSearchParams({ q })}`)
      .then((r) => (Array.isArray(r?.guilds) ? r.guilds : null), () => null)
      .then((u) => {
        if (g !== searchGen.current) return
        setSearching(false)
        setFound(u)
        setSearchFailed(!u)
      })
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    const q = draft.trim()
    if ([...q].length < 2) {
      setHint('Tape au moins 2 caractères.')
      return
    }
    setHint(null)
    lastQuery.current = q
    void search(q)
  }

  const readDetail = (gid: string) => {
    const g = ++detailGen.current
    return api<GuildDetail | null>(`/api/admin/guilds/${gid}`).then(readableDetail, () => null).then((d) => {
      if (g !== detailGen.current) return
      setDetail(d)
      setDetailFailed(!d)
      setSettled(gid)
    })
  }
  // Autre guilde : la fiche d'avant n'est plus montrée (état ajusté au rendu), la réponse d'une lecture quittée est jetée (génération).
  const [shown, setShown] = useState(guildId)
  if (shown !== guildId) {
    setShown(guildId); setDetail(null); setDetailFailed(false); setModal(null); setTyped('')
  }
  const onGuild = useEffectEvent((gid: string | null) => {
    if (gid) void readDetail(gid)
    else {
      detailGen.current++
      if (focusAfter.current === 'input') { focusAfter.current = null; input.current?.focus() }
    }
  })
  useEffect(() => { onGuild(guildId) }, [guildId])

  useEffect(() => {
    const want = focusAfter.current
    if (!want || want === 'input') return
    if (want === 'search' && (found || searchFailed)) {
      focusAfter.current = null
      ;(searchFailed ? retrySearch.current : results.current)?.focus()
    } else if (want === 'detail' && (detail || detailFailed)) {
      focusAfter.current = null
      ;(detailFailed ? retryDetail.current : heading.current)?.focus()
    }
  }, [found, searchFailed, detail, detailFailed])

  const post = async (intent: string, path: string, reason: string) => {
    const res = await apiOnce<{ ok?: boolean } | null>(keys, `${intent}:${reason}`, path, { method: 'DELETE', body: JSON.stringify({ reason }) })
    if (!res) throw new Error('unreadable')
  }
  const reread = () => {
    setModal(null)
    focusAfter.current = 'detail'
    if (guildId) void readDetail(guildId)
  }

  const admin = role === 'admin'
  const d = detail
  const ready = !searching && (!guildId || settled === guildId)

  return (
    <div data-ready={ready ? '' : undefined} className="space-y-6">
      <PageHeader title="Guildes" icon={Shield} />
      <form role="search" onSubmit={submit} className="space-y-1">
        <label htmlFor={`${id}-q`} className="text-sm font-semibold">Rechercher une guilde</label>
        <input ref={input} id={`${id}-q`} type="search" value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} className={FIELD} />
        {hint && <p id={`${id}-hint`} role="alert" className="text-sm font-medium text-red-400">{hint}</p>}
      </form>

      {searching ? <Loading label="Recherche en cours" /> : searchFailed ? (
        <LoadError ref={retrySearch} text="La recherche n'a pas abouti." onRetry={() => { focusAfter.current = 'search'; void search(lastQuery.current) }} />
      ) : found && (
        <section aria-labelledby={`${id}-results`} className="space-y-2">
          <h2 ref={results} id={`${id}-results`} tabIndex={-1} className="text-lg font-bold outline-none">Résultats</h2>
          {found.length ? (
            <ul className="space-y-2">
              {found.map((g) => (
                <li key={g.id}>
                  <Link
                    href={`/admin/guilds?guild=${g.id}`}
                    aria-current={g.id === guildId ? 'true' : undefined}
                    className="card-frame flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 transition-colors hover:bg-[var(--color-surface-light)]"
                  >
                    <span className="min-w-0 font-semibold wrap-anywhere">{g.name}</span>
                    <span className="text-sm text-[var(--color-foreground)]/70">{`${formatInt(g.member_count)} ${g.member_count > 1 ? 'membres' : 'membre'}`}</span>
                    {g.leader_username && <span className="text-sm text-[var(--color-foreground)]/70 wrap-anywhere">{`Chef : ${g.leader_username}`}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="card-frame p-6 text-center text-sm">Aucune guilde trouvée.</p>}
        </section>
      )}

      {guildId && (d ? (
        <section aria-labelledby={`${id}-name`} className="space-y-4">
          <div className="card-frame space-y-2 p-4">
            <h2 ref={heading} id={`${id}-name`} tabIndex={-1} className="text-xl font-bold outline-none wrap-anywhere">{d.guild.name}</h2>
            {d.guild.description && <p className="text-sm whitespace-pre-wrap wrap-anywhere">{d.guild.description}</p>}
            <p className="text-sm text-[var(--color-foreground)]/70">{`Créée le ${formatShortDate(d.guild.created_at)}`}</p>
          </div>
          {admin && <button type="button" onClick={() => { setTyped(''); setModal('dissolve') }} className={ghost}>Dissoudre la guilde</button>}

          <section aria-labelledby={`${id}-members`} className="space-y-2">
            <h3 id={`${id}-members`} className="text-lg font-bold">Membres</h3>
            <ul className="space-y-2">
              {d.members.map((m) => (
                <li key={m.user_id} className="card-frame flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <span className="min-w-0 font-semibold wrap-anywhere">{m.username}</span>
                  {m.user_id === d.guild.leader_id && <span className="font-medium">Chef</span>}
                  <span className="text-[var(--color-foreground)]/70">{`Membre depuis le ${formatShortDate(m.joined_at)}`}</span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby={`${id}-messages`} className="space-y-2">
            <h3 id={`${id}-messages`} className="text-lg font-bold">Derniers messages</h3>
            <div role="log" aria-label="Messages de la guilde" className="space-y-2">
              {d.messages.length ? d.messages.map((m) => (
                <div key={m.id} className="card-frame space-y-1 p-3 text-sm">
                  <p className="wrap-anywhere"><span className="font-semibold">{m.username}</span>{' '}<time dateTime={m.created_at} className="text-[var(--color-foreground)]/70">{formatDateTime(m.created_at)}</time></p>
                  <p className="whitespace-pre-wrap wrap-anywhere">{m.content}</p>
                  <button type="button" onClick={() => setModal({ message: m })} className={link}>Supprimer</button>
                </div>
              )) : <p className="card-frame p-6 text-center text-sm">Aucun message.</p>}
            </div>
          </section>

          <section aria-labelledby={`${id}-wishes`} className="space-y-2">
            <h3 id={`${id}-wishes`} className="text-lg font-bold">Demandes ouvertes</h3>
            {d.wishes.length ? (
              <ul className="space-y-2">
                {d.wishes.map((w) => (
                  <li key={w.id} className="card-frame flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                    <span className="min-w-0 font-semibold wrap-anywhere">{w.wikipedia_title}</span>
                    <span className="wrap-anywhere">{w.username}</span>
                    <button type="button" onClick={() => setModal({ wish: w })} className={link}>Retirer la demande</button>
                  </li>
                ))}
              </ul>
            ) : <p className="card-frame p-6 text-center text-sm">Aucune demande ouverte.</p>}
          </section>
        </section>
      ) : detailFailed ? (
        <LoadError ref={retryDetail} text="La fiche n'a pas pu être chargée." onRetry={() => { focusAfter.current = 'detail'; setDetailFailed(false); void readDetail(guildId) }} />
      ) : <Loading label="Chargement de la fiche" />)}

      {d && modal === 'dissolve' && (
        <ActionModal
          title="Dissoudre cette guilde ?"
          consequence="Les membres sont prévenus. Messages, demandes, dons et scores de la guilde disparaissent."
          action="Dissoudre la guilde"
          tone="danger"
          valid={typed.trim() === d.guild.name}
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`dissolve:${d.guild.id}`, `/api/admin/guilds/${d.guild.id}`, reason)
            toast('Guilde dissoute.')
            setModal(null)
            setFound(null)
            focusAfter.current = 'input'
            router.replace('/admin/guilds')
          }}
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">Cette action est irréversible.</p>
            <label htmlFor={`${id}-confirm`} className="text-sm font-semibold">Tape le nom de la guilde pour confirmer</label>
            <input id={`${id}-confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className={FIELD} />
          </div>
        </ActionModal>
      )}
      {d && modal && typeof modal === 'object' && 'message' in modal && (
        <ActionModal
          title="Supprimer ce message ?"
          consequence="Le message disparaît pour toute la guilde."
          action="Supprimer"
          tone="danger"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`msg:${modal.message.id}`, `/api/admin/guild-messages/${modal.message.id}`, reason)
            toast('Message supprimé.')
            reread()
          }}
        />
      )}
      {d && modal && typeof modal === 'object' && 'wish' in modal && (
        <ActionModal
          title="Retirer cette demande ?"
          consequence="La demande disparaît de la guilde."
          action="Retirer la demande"
          tone="danger"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`wish:${modal.wish.id}`, `/api/admin/guild-wishes/${modal.wish.id}`, reason)
            toast('Demande retirée.')
            reread()
          }}
        />
      )}
    </div>
  )
}
