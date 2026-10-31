'use client'

import { Users } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from 'react'
import { ActionModal } from '@/components/admin/ActionModal'
import { SanctionModal } from '@/components/admin/SanctionModal'
import type { Sanction, SearchUser, StaffRole, UserDetail } from '@/components/admin/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { link, ghost } from '@/components/ui/button'
import { DataTable } from '@/components/ui/DataTable'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { toast } from '@/components/ui/toast'
import { api, apiOnce } from '@/lib/api'
import { formatInt, formatShortDate } from '@/lib/format'

const KIND: Record<string, string> = { warning: 'Avertissement', restriction: 'Restriction', suspension: 'Suspension', ban: 'Bannissement' }
const FIELD = 'block min-h-11 w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'
type Modal = 'sanction' | 'recheck' | 'sync' | { lift: Sanction }

const readableDetail = (d: UserDetail | null): UserDetail | null => (d && d.user && Array.isArray(d.sanctions) && typeof d.user.username === 'string' ? d : null)
const stateOf = (s: Sanction) => (s.revoked_at ? `Levée le ${formatShortDate(s.revoked_at)}` : s.active ? 'Active' : Date.parse(s.starts_at) > Date.now() ? 'À venir' : 'Échue')

// /admin/users : recherche par début de pseudo (Entrée), fiche du joueur choisi (?user=<id>), sanctions posées et levées.
// Suspension, bannissement et resynchronisation de la session sont réservés aux administrateurs : l'interface les masque, l'API les refuse.
export function UsersClient({ role }: { role: StaffRole }) {
  const id = useId()
  const userId = useSearchParams().get('user') || null
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [found, setFound] = useState<SearchUser[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  // Fiche lue (ou en échec) : celle de ce joueur, pour data-ready.
  const [settled, setSettled] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  // GoTrue en retard après une sanction ou une levée (auth_synced faux), pour le joueur affiché.
  const [desync, setDesync] = useState(false)
  const searchGen = useRef(0)
  const detailGen = useRef(0)
  const [keys] = useState(() => new Map<string, string>())
  const lastQuery = useRef('')
  const heading = useRef<HTMLHeadingElement>(null)
  const caption = useRef<HTMLTableCaptionElement>(null)
  const results = useRef<HTMLHeadingElement>(null)
  const retrySearch = useRef<HTMLButtonElement>(null)
  const retryDetail = useRef<HTMLButtonElement>(null)
  const focusAfter = useRef<'search' | 'detail' | 'sanctions' | null>(null)

  const search = (q: string) => {
    const g = ++searchGen.current
    setSearching(true)
    setSearchFailed(false)
    return api<{ users?: SearchUser[] } | null>(`/api/admin/users?${new URLSearchParams({ q })}`)
      .then((r) => (Array.isArray(r?.users) ? r.users : null), () => null)
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

  const readDetail = (uid: string) => {
    const g = ++detailGen.current
    return api<UserDetail | null>(`/api/admin/users/${uid}`).then(readableDetail, () => null).then((d) => {
      if (g !== detailGen.current) return
      setDetail(d)
      setDetailFailed(!d)
      setSettled(uid)
    })
  }
  // Autre joueur : la fiche d'avant n'est plus montrée (état ajusté au rendu), la réponse d'une lecture quittée est jetée (génération).
  const [shown, setShown] = useState(userId)
  if (shown !== userId) {
    setShown(userId); setDetail(null); setDetailFailed(false); setDesync(false); setModal(null)
  }
  const onUser = useEffectEvent((uid: string | null) => {
    if (uid) void readDetail(uid)
    else detailGen.current++
  })
  useEffect(() => { onUser(userId) }, [userId])

  useEffect(() => {
    const want = focusAfter.current
    if (!want) return
    if (want === 'search' && (found || searchFailed)) {
      focusAfter.current = null
      ;(searchFailed ? retrySearch.current : results.current)?.focus()
    } else if (want !== 'search' && (detail || detailFailed)) {
      focusAfter.current = null
      ;(detailFailed ? retryDetail.current : want === 'sanctions' ? (caption.current ?? heading.current) : heading.current)?.focus()
    }
  }, [found, searchFailed, detail, detailFailed])

  // Action réussie : modale fermée, fiche relue ; « Lever » disparaît de sa ligne, le focus va à la table.
  const done = (res: { auth_synced?: boolean } | null, lifted: boolean) => {
    if (res && res.auth_synced === false) setDesync(true)
    else if (res?.auth_synced === true) setDesync(false)
    setModal(null)
    if (lifted) focusAfter.current = 'sanctions'
    if (userId) void readDetail(userId)
  }
  const post = async (intent: string, path: string, reason: string) => {
    const body = JSON.stringify({ reason })
    const res = await apiOnce<{ auth_synced?: boolean } | null>(keys, `${intent}:${reason}`, path, { method: 'POST', body })
    if (!res) throw new Error('unreadable')
    return res
  }

  const admin = role === 'admin'
  const d = detail
  const ready = !searching && (!userId || settled === userId)
  const who = d?.user.username ?? ''
  const canAct = !!d && (admin || !d.staff_role)

  return (
    <div data-ready={ready ? '' : undefined} className="space-y-6">
      <PageHeader title="Joueurs" icon={Users} />
      <form role="search" onSubmit={submit} className="space-y-1">
        <label htmlFor={`${id}-q`} className="text-sm font-semibold">Rechercher un joueur</label>
        <input id={`${id}-q`} type="search" value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} className={FIELD} />
        {hint && <p id={`${id}-hint`} role="alert" className="text-sm font-medium text-red-400">{hint}</p>}
      </form>

      {searching ? <Loading label="Recherche en cours" /> : searchFailed ? (
        <LoadError ref={retrySearch} text="La recherche n'a pas abouti." onRetry={() => { focusAfter.current = 'search'; void search(lastQuery.current) }} />
      ) : found && (
        <section aria-labelledby={`${id}-results`} className="space-y-2">
          <h2 ref={results} id={`${id}-results`} tabIndex={-1} className="text-lg font-bold outline-none">Résultats</h2>
          {found.length ? (
            <ul className="space-y-2">
              {found.map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/admin/users?user=${u.id}`}
                    aria-current={u.id === userId ? 'true' : undefined}
                    className="card-frame flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 transition-colors hover:bg-[var(--color-surface-light)]"
                  >
                    <span className="min-w-0 font-semibold wrap-anywhere">{u.username}</span>
                    <span className="text-sm text-[var(--color-foreground)]/70">{`Inscrit le ${formatShortDate(u.created_at)}`}</span>
                    {u.deleted && <span className="text-sm font-medium">Compte supprimé</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="card-frame p-6 text-center text-sm">Aucun joueur trouvé.</p>}
        </section>
      )}

      {userId && (d ? (
        <section aria-labelledby={`${id}-name`} className="space-y-4">
          <div className="card-frame space-y-2 p-4">
            <h2 ref={heading} id={`${id}-name`} tabIndex={-1} className="text-xl font-bold outline-none wrap-anywhere">{who}</h2>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {d.user.deleted_at && <li className="font-medium">Compte supprimé</li>}
              {d.user.is_pro && <li>Pro</li>}
              {d.user.is_vip && <li>VIP</li>}
              <li>{`${formatInt(d.user.balance)} ${d.user.balance > 1 ? 'wikibidous' : 'wikibidou'}`}</li>
              <li>{d.user.is_public ? 'Profil public' : 'Profil privé'}</li>
              <li className="wrap-anywhere">{d.guild ? `Guilde : ${d.guild.name}` : 'Aucune guilde'}</li>
              <li>{`Signalements reçus : ${formatInt(d.reports_received)}`}</li>
              <li>{`Signalements déposés : ${formatInt(d.reports_filed)}`}</li>
              {d.staff_role && <li>{d.staff_role === 'admin' ? 'Rôle staff : administrateur' : 'Rôle staff : modérateur'}</li>}
            </ul>
          </div>
          <div className="flex flex-wrap gap-3">
            {canAct && <button type="button" onClick={() => setModal('sanction')} className={ghost}>Sanctionner</button>}
            <button type="button" onClick={() => setModal('recheck')} className={ghost}>Rouvrir le check</button>
            {/* Pour tout admin : un échec GoTrue signalé ailleurs (signalements, rechargement) n'est pas connu de cette page ; idempotent. */}
            {admin && <button type="button" onClick={() => setModal('sync')} className={ghost}>Resynchroniser la session</button>}
          </div>
          {admin && (d.user.auth_pending || desync) && <p role="status" className="text-sm font-medium">La session GoTrue n&apos;a pas pu être mise à jour : resynchronise-la.</p>}
          <section aria-labelledby={`${id}-sanctions`} className="space-y-2">
            <h3 id={`${id}-sanctions`} className="text-lg font-bold">Sanctions</h3>
            {d.sanctions.length ? (
              <DataTable<Sanction>
                caption={`Sanctions de ${who}`}
                captionRef={caption}
                rows={d.sanctions}
                rowKey={(s) => String(s.id)}
                columns={[
                  { key: 'kind', header: 'Type', cellClassName: 'wrap-anywhere', cell: (s) => KIND[s.kind] ?? s.kind },
                  { key: 'reason', header: 'Motif', cellClassName: 'wrap-anywhere', cell: (s) => s.reason },
                  { key: 'start', header: 'Début', cellClassName: 'wrap-anywhere', cell: (s) => formatShortDate(s.starts_at) },
                  { key: 'end', header: 'Fin', cellClassName: 'wrap-anywhere', cell: (s) => (s.ends_at ? formatShortDate(s.ends_at) : 'sans fin') },
                  { key: 'state', header: 'État', cellClassName: 'wrap-anywhere', cell: stateOf },
                  {
                    key: 'action',
                    header: 'Action',
                    cell: (s) => (s.active && (admin || s.kind === 'warning' || s.kind === 'restriction')
                      ? <button type="button" onClick={() => setModal({ lift: s })} className={link}>Lever</button> : null),
                  },
                ]}
              />
            ) : <p className="card-frame p-6 text-center text-sm">Aucune sanction.</p>}
          </section>
        </section>
      ) : detailFailed ? (
        <LoadError ref={retryDetail} text="La fiche n'a pas pu être chargée." onRetry={() => { focusAfter.current = 'detail'; setDetailFailed(false); void readDetail(userId) }} />
      ) : <Loading label="Chargement de la fiche" />)}

      {d && modal === 'sanction' && (
        <SanctionModal user={{ id: d.user.id, username: who }} role={role} keys={keys} onDone={(res) => done(res, false)} onClose={() => setModal(null)} />
      )}
      {d && modal === 'recheck' && (
        <ActionModal
          title="Rouvrir le check ?"
          consequence="Les succès du joueur sont recalculés à sa prochaine connexion."
          action="Rouvrir le check"
          tone="primary"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`recheck:${d.user.id}`, `/api/admin/users/${d.user.id}/achievements-recheck`, reason)
            toast('Check rouvert.')
            done(null, false)
          }}
        />
      )}
      {d && modal === 'sync' && (
        <ActionModal
          title="Resynchroniser la session ?"
          consequence="L'état de la session du joueur est recopié depuis ses sanctions."
          action="Resynchroniser"
          tone="primary"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            const res = await post(`sync:${d.user.id}`, `/api/admin/users/${d.user.id}/auth-sync`, reason)
            toast(res.auth_synced === false ? 'La session n\'a pas pu être resynchronisée.' : 'Session resynchronisée.')
            done(res, false)
          }}
        />
      )}
      {d && modal && typeof modal === 'object' && (
        <ActionModal
          title="Lever cette sanction ?"
          consequence="Le joueur retrouve l'accès que cette sanction lui retirait."
          action="Lever"
          tone="danger"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            const res = await post(`lift:${modal.lift.id}`, `/api/admin/sanctions/${modal.lift.id}/revoke`, reason)
            toast('Sanction levée.')
            done(res, true)
          }}
        />
      )}
    </div>
  )
}
