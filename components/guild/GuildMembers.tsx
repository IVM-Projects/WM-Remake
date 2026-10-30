'use client'

import Link from 'next/link'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { danger, ghost, link, primary } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { ReadError } from '@/components/ui/Section'
import { toast } from '@/components/ui/toast'
import { api, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatShortDate } from '@/lib/format'
import { isNoGuild, type Member, type MemberPage } from './types'

type Player = { id: string; username: string }
type Friendship = { status: 'pending' | 'accepted'; requester_id: string; requester: Player; addressee: Player }
type Act = { kind: 'kick' | 'lead'; m: Member }

export function ChefPill() {
  return <span className="rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-xs font-semibold text-[var(--color-accent-light)]">Chef</span>
}

const readable = (r: MemberPage | null): MemberPage | null => (Array.isArray(r?.members) && typeof r.hasMore === 'boolean' ? r : null)
const fail = (e: unknown) => (unsure(e) ? UNSURE : userMessage(e, 'L\'action n\'a pas abouti.'))

// Onglet « Membres » : le chef d'abord, 50 par page. Exclusion et transfert (chef seulement) confirmés en modale ; « Inviter un ami » pour tous.
// onLost : un 404 « aucune guilde » (exclu entre-temps) ; onChanged : relire la guilde ; onHeading / onTab : cibles du focus.
export function GuildMembers({ me, onLost, onChanged, onHeading, onTab }: {
  me: string; onLost: () => void; onChanged: () => void; onHeading: () => void; onTab: () => void
}) {
  const id = useId()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [moreFailed, setMoreFailed] = useState(false)
  const [act, setAct] = useState<Act | null>(null)
  const [inviting, setInviting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const gen = useRef(0)
  const list = useRef<HTMLUListElement>(null)
  // Cible du focus quand l'élément focalisé disparaît : rang de l'« Exclure » retiré, ou le titre de la guilde.
  const pending = useRef<number | 'heading' | 'tab' | null>(null)

  const load = (offset: number) => {
    const g = ++gen.current
    return api<MemberPage | null>(`/api/guilds/members?limit=50&offset=${offset}`).then(readable, (e) => {
      if (isNoGuild(e)) onLost()
      return null
    }).then((r) => (g === gen.current ? r : undefined))
  }
  function first() {
    void load(0).then((r) => {
      if (r === undefined) return
      if (r) {
        setMembers(r.members)
        setHasMore(r.hasMore)
      }
      setFailed(!r)
    })
  }
  function more() {
    setMoreFailed(false)
    void load(members?.length ?? 0).then((r) => {
      if (r === undefined) return
      if (!r) return setMoreFailed(true)
      setMembers((m) => [...(m ?? []), ...r.members.filter((x) => !m?.some((y) => y.user_id === x.user_id))])
      setHasMore(r.hasMore)
    })
  }
  const onMount = useEffectEvent(first)
  useEffect(() => onMount(), [])
  function retry() {
    pending.current = 'tab'
    setFailed(false)
    first()
  }

  const refocus = useEffectEvent(() => {
    const p = pending.current
    if (p === null || (members === null && !failed)) return
    pending.current = null
    if (document.activeElement !== document.body) return
    if (p === 'tab') return onTab()
    const kicks = list.current?.querySelectorAll<HTMLElement>('[data-kick]')
    if (typeof p === 'number' && kicks?.length) return kicks[Math.min(p, kicks.length - 1)].focus()
    onHeading()
  })
  useEffect(() => refocus(), [members, failed])

  // Le chef est celui de la liste lue ; le transfert le change ici même, avant la relecture de la guilde.
  const isLeader = members?.find((m) => m.role === 'leader')?.user_id === me
  const others = members?.filter((m) => m.user_id !== me) ?? []

  async function confirm() {
    if (!act || inflight.current) return
    const { kind, m } = act
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      await apiOnce(keys.current, `${kind}:${m.user_id}`, kind === 'kick' ? '/api/guilds/kick' : '/api/guilds/transfer-leadership',
        { method: 'POST', body: JSON.stringify({ user_id: m.user_id }) })
      toast(kind === 'kick' ? `${m.username} a été exclu de la guilde.` : `${m.username} est maintenant chef de la guilde.`)
      pending.current = kind === 'kick' ? Math.max(0, others.filter((o) => o.role !== 'leader').findIndex((o) => o.user_id === m.user_id)) : 'heading'
      setAct(null)
      setMembers((all) => (kind === 'kick'
        ? all?.filter((x) => x.user_id !== m.user_id)
        : all?.map((x): Member => ({ ...x, role: x.user_id === m.user_id ? 'leader' : 'member' })).sort((a, b) => +(b.role === 'leader') - +(a.role === 'leader'))) ?? null)
      onChanged()
    } catch (e) {
      if (isNoGuild(e)) return void onLost()
      setError(fail(e))
      first()
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }
  const close = () => {
    if (inflight.current) return
    setAct(null)
    setError(null)
  }

  return (
    <div className="space-y-4">
      <button type="button" aria-haspopup="dialog" onClick={() => setInviting(true)} className={primary}>Inviter un ami</button>
      {members ? (
        <>
          <ul ref={list} className="card-frame divide-y divide-[var(--color-border)] px-4">
            {members.map((m) => {
              const who = `${id}-who-${m.user_id}`
              return (
                <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <Link id={who} href={`/profile/${encodeURIComponent(m.username)}`} className={`${link} min-w-0 wrap-anywhere`}>{m.username}</Link>
                    {m.role === 'leader' && <ChefPill />}
                    <span className="text-sm text-[var(--color-foreground)]/70">{`Membre depuis le ${formatShortDate(m.joined_at)}`}</span>
                  </div>
                  {isLeader && m.user_id !== me && (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" aria-haspopup="dialog" aria-describedby={who} onClick={() => setAct({ kind: 'lead', m })} className={ghost}>Nommer chef</button>
                      <button type="button" data-kick="" aria-haspopup="dialog" aria-describedby={who} onClick={() => setAct({ kind: 'kick', m })} className={ghost}>Exclure</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {moreFailed && <ReadError onRetry={more}>Les membres n&apos;ont pas pu être chargés.</ReadError>}
          {hasMore && !moreFailed && <button type="button" onClick={more} className={ghost}>Charger la suite</button>}
        </>
      ) : failed ? (
        <ReadError onRetry={retry}>Les membres n&apos;ont pas pu être chargés.</ReadError>
      ) : (
        <Loading label="Chargement des membres" />
      )}

      {act && (
        <Modal onClose={close} labelledBy={`${id}-act`} className="card-frame relative w-full max-w-md animate-fade-in-up space-y-4 p-6">
          <h2 id={`${id}-act`} className="text-xl font-bold wrap-anywhere">
            {act.kind === 'kick' ? `Exclure ${act.m.username} de la guilde ?` : `Nommer ${act.m.username} chef de la guilde ?`}
          </h2>
          <p className="text-sm">{act.kind === 'kick' ? 'Il ne pourra revenir que sur une nouvelle invitation.' : 'Tu deviendras simple membre.'}</p>
          {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
            <button type="button" aria-disabled={busy || undefined} onClick={() => void confirm()} className={act.kind === 'kick' ? danger : primary}>
              {act.kind === 'kick' ? 'Exclure' : 'Nommer chef'}
            </button>
          </div>
        </Modal>
      )}
      {inviting && <InviteDialog me={me} members={members ?? []} onClose={() => setInviting(false)} onLost={onLost} />}
    </div>
  )
}

// « Inviter un ami » : les amis acceptés qui ne sont pas déjà dans la liste des membres lus.
function InviteDialog({ me, members, onClose, onLost }: { me: string; members: Member[]; onClose: () => void; onLost: () => void }) {
  const id = useId()
  const [friends, setFriends] = useState<Player[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [invited, setInvited] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())

  function read() {
    void api<{ friendships: Friendship[] } | null>('/api/friends').catch(() => null).then((r) => {
      if (!Array.isArray(r?.friendships)) return setFailed(true)
      setFriends(r.friendships.filter((f) => f.status === 'accepted').map((f) => (f.requester_id === me ? f.addressee : f.requester)))
      setFailed(false)
    })
  }
  const onMount = useEffectEvent(read)
  useEffect(() => onMount(), [])

  async function send(f: Player) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      await apiOnce(keys.current, `invite:${f.id}`, '/api/guilds/invite', { method: 'POST', body: JSON.stringify({ user_id: f.id }) })
      toast(`Invitation envoyée à ${f.username}.`)
      setInvited((l) => [...l, f.id])
    } catch (e) {
      if (isNoGuild(e)) {
        onClose()
        return void onLost()
      }
      setError(fail(e))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const rows = friends?.filter((f) => !members.some((m) => m.user_id === f.id))
  return (
    <Modal onClose={onClose} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-md max-h-[90vh] animate-fade-in-up space-y-4 overflow-y-auto p-6">
      <h2 id={`${id}-title`} className="text-xl font-bold">Inviter un ami</h2>
      {rows ? (
        rows.length ? (
          <ul className="divide-y divide-[var(--color-border)]">
            {rows.map((f) => {
              const who = `${id}-who-${f.id}`
              return (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
                  <span id={who} className="min-w-0 font-medium wrap-anywhere">{f.username}</span>
                  {invited.includes(f.id) ? (
                    <span className="text-sm text-[var(--color-foreground)]/70">Invité</span>
                  ) : (
                    <button type="button" aria-disabled={busy || undefined} aria-describedby={who} onClick={() => void send(f)} className={primary}>Inviter</button>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm">Aucun ami à inviter.</p>
        )
      ) : failed ? (
        <ReadError onRetry={() => { setFailed(false); read() }}>Tes amis n&apos;ont pas pu être chargés.</ReadError>
      ) : (
        <Loading label="Chargement des amis" />
      )}
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      <div className="flex justify-end">
        <button type="button" onClick={onClose} className={ghost}>Fermer</button>
      </div>
    </Modal>
  )
}
