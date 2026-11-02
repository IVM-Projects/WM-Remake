'use client'

import { ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ActionModal } from '@/components/admin/ActionModal'
import type { Dashboard, StaffRole } from '@/components/admin/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { ghost, link } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { toast } from '@/components/ui/toast'
import { api, apiOnce } from '@/lib/api'
import { formatDateTime, formatInt } from '@/lib/format'
import { formatPrice } from '@/lib/shop'

const COUNTS = ['open_reports', 'image_reports', 'auto_hidden_cards', 'active_sanctions', 'removed_cards', 'auth_pending', 'stripe_disputes_open', 'stripe_pending'] as const
const readable = (d: Dashboard | null): Dashboard | null => (
  d && COUNTS.every((k) => Number.isFinite(d[k])) && d.health && typeof d.health === 'object' && Array.isArray(d.stripe_disputes) && Array.isArray(d.stripe_pending_users) ? d : null
)
const unmeasured = 'non mesuré'
const secs = (n: number | null | undefined) => (typeof n === 'number' ? `${formatInt(n)} s` : unmeasured)

// /admin : compteurs à traiter et santé du système (wm.health). Une lecture à l'affichage, aucun poll.
export function DashboardClient({ role }: { role: StaffRole }) {
  const [data, setData] = useState<Dashboard | null>(null)
  // Compte supprimé dont l'abonnement est à résilier (modale ouverte).
  const [cancel, setCancel] = useState<{ id: string; username: string } | null>(null)
  const keys = useRef(new Map<string, string>())
  const [failed, setFailed] = useState(false)
  const retry = useRef<HTMLButtonElement>(null)
  const h1 = useRef<HTMLHeadingElement>(null)
  const refocus = useRef(false)

  const read = () => api<Dashboard | null>('/api/admin/dashboard').then(readable, () => null).then((d) => { setData(d); setFailed(!d) })
  const onMount = useEffectEvent(() => { void read() })
  useEffect(() => { onMount() }, [])
  useEffect(() => {
    if (refocus.current && (data || failed)) { refocus.current = false; (failed ? retry.current : h1.current)?.focus() }
  }, [data, failed])

  // [libellé, nombre, lien, suppression GoTrue en attente]
  const tiles: [string, number, string, boolean][] = data ? [
    ['Signalements à traiter', data.open_reports, '/admin/reports', false],
    ['Images signalées', data.image_reports, '/admin/reports', false],
    ['Images masquées d\'office', data.auto_hidden_cards, '/admin/cards', false],
    ['Sanctions actives', data.active_sanctions, '/admin/users', false],
    ['Cartes retirées', data.removed_cards, '/admin/cards', false],
    ...(data.auth_pending > 0 ? [['Suppressions GoTrue en attente', data.auth_pending, '/admin/users', true] as [string, number, string, boolean]] : []),
    ...(data.stripe_disputes_open > 0 ? [['Litiges Stripe ouverts', data.stripe_disputes_open, '#admin-disputes', false] as [string, number, string, boolean]] : []),
    ...(data.stripe_pending > 0 ? [['Résiliations Stripe en attente', data.stripe_pending, '#admin-stripe-pending', false] as [string, number, string, boolean]] : []),
  ] : []
  const h = data?.health

  return (
    <div data-ready={data || failed ? '' : undefined} className="space-y-6">
      <PageHeader ref={h1} title="Administration" icon={ShieldCheck} />
      {!data ? (
        failed ? (
          <LoadError ref={retry} text="Le tableau de bord n'a pas pu être chargé." onRetry={() => { refocus.current = true; setFailed(false); void read() }} />
        ) : <Loading label="Chargement du tableau de bord" />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tiles.map(([label, n, href, pending]) => (
              <li key={label} className="card-frame space-y-1 p-4">
                <p className="text-3xl font-bold tabular-nums">{formatInt(n)}</p>
                <Link href={href} className={link}>{label}</Link>
                {pending && <p className="text-sm">Resynchroniser depuis la fiche du joueur</p>}
              </li>
            ))}
          </ul>
          {data.stripe_disputes.length > 0 && (
            <section aria-labelledby="admin-disputes" className="card-frame space-y-3 p-4">
              <h2 id="admin-disputes" tabIndex={-1} className="text-lg font-bold outline-none">Litiges Stripe</h2>
              {data.stripe_disputes_open > data.stripe_disputes.length && (
                <p className="text-sm text-[var(--color-foreground)]/70">Les {formatInt(data.stripe_disputes.length)} plus récents sur {formatInt(data.stripe_disputes_open)}.</p>
              )}
              <ul className="divide-y divide-[var(--color-border)]">
                {data.stripe_disputes.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                    <div className="min-w-0 text-sm">
                      {/* shortcut: formatPrice est en CAD (G7, seule devise du compte) ; une autre devise demanderait la sienne. */}
                      <p className="font-medium tabular-nums">{formatPrice(d.amount)}</p>
                      <p className="wrap-anywhere text-[var(--color-foreground)]/70">{d.reason ?? 'Motif non précisé'} · {formatDateTime(d.created_at)} · {d.id}</p>
                    </div>
                    <a href={`https://dashboard.stripe.com/test/disputes/${encodeURIComponent(d.id)}`} target="_blank" rel="noopener noreferrer" className={link}>
                      Voir dans Stripe<span className="sr-only"> (nouvel onglet)</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.stripe_pending_users.length > 0 && (
            <section aria-labelledby="admin-stripe-pending" className="card-frame space-y-3 p-4">
              <h2 id="admin-stripe-pending" tabIndex={-1} className="text-lg font-bold outline-none">Comptes supprimés à résilier</h2>
              {data.stripe_pending > data.stripe_pending_users.length && (
                <p className="text-sm text-[var(--color-foreground)]/70">Les {formatInt(data.stripe_pending_users.length)} plus anciens sur {formatInt(data.stripe_pending)}.</p>
              )}
              <ul className="divide-y divide-[var(--color-border)]">
                {data.stripe_pending_users.map((u) => (
                  <li key={u.user_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                    <p className="min-w-0 text-sm wrap-anywhere">
                      <span className="font-medium">{u.username}</span>
                      <span className="text-[var(--color-foreground)]/70"> · supprimé le {formatDateTime(u.deleted_at)}</span>
                    </p>
                    {role === 'admin' && (
                      <button type="button" aria-label={`Résilier l'abonnement de ${u.username}`} onClick={() => setCancel({ id: u.user_id, username: u.username })} className={`${ghost} justify-center`}>
                        Résilier
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="admin-health" className="card-frame space-y-3 p-4">
            <h2 id="admin-health" className="text-lg font-bold">Santé</h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div><dt className="text-[var(--color-foreground)]/70">Retard du règlement</dt><dd className="tabular-nums">{secs(h?.settle_lag_s)}</dd></div>
              <div><dt className="text-[var(--color-foreground)]/70">Ventes en retard</dt><dd className="tabular-nums">{secs(h?.overdue_s)}</dd></div>
              <div><dt className="text-[var(--color-foreground)]/70">Retard des notifications</dt><dd className="tabular-nums">{secs(h?.push_lag_s)}</dd></div>
              <div>
                <dt className="text-[var(--color-foreground)]/70">File de quiz</dt>
                <dd className="tabular-nums">
                  {typeof h?.quiz?.queued === 'number' ? `${formatInt(h.quiz.queued)} en attente, la plus ancienne : ${secs(h.quiz.oldest_s)}` : unmeasured}
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}
      {cancel && (
        <ActionModal
          title="Résilier l'abonnement ?"
          consequence="L'abonnement Stripe de ce compte supprimé est résilié tout de suite, sans remboursement."
          action="Résilier"
          tone="danger"
          onClose={() => setCancel(null)}
          onConfirm={async (reason) => {
            const res = await apiOnce<{ stripe_synced?: unknown } | null>(keys.current, `stripe-cancel:${cancel.id}:${reason}`,
              `/api/admin/users/${cancel.id}/stripe-cancel`, { method: 'POST', body: JSON.stringify({ reason }) })
            if (typeof res?.stripe_synced !== 'boolean') throw new Error('unreadable')
            toast(res.stripe_synced ? 'Abonnement résilié.' : 'La résiliation a échoué chez Stripe : réessaie plus tard.')
            setCancel(null)
            // Résiliée : la ligne disparaît de la relecture, le focus attend sur le titre. Échec : la ligne reste, la modale rend le focus à son bouton.
            refocus.current = res.stripe_synced
            void read()
          }}
        />
      )}
    </div>
  )
}
