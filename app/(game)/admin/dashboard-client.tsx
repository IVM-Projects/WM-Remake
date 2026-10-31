'use client'

import { ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Dashboard } from '@/components/admin/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { link } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { api } from '@/lib/api'
import { formatInt } from '@/lib/format'

const readable = (d: Dashboard | null): Dashboard | null => (d && typeof d.open_reports === 'number' && d.health && typeof d.health === 'object' ? d : null)
const unmeasured = 'non mesuré'
const secs = (n: number | null | undefined) => (typeof n === 'number' ? `${formatInt(n)} s` : unmeasured)

// /admin : compteurs à traiter et santé du système (wm.health). Une lecture à l'affichage, aucun poll.
export function DashboardClient() {
  const [data, setData] = useState<Dashboard | null>(null)
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

  const tiles: [string, number, string][] = data ? [
    ['Signalements à traiter', data.open_reports, '/admin/reports'],
    ['Images signalées', data.image_reports, '/admin/reports'],
    ['Images masquées d\'office', data.auto_hidden_cards, '/admin/cards'],
    ['Sanctions actives', data.active_sanctions, '/admin/users'],
    ['Cartes retirées', data.removed_cards, '/admin/cards'],
    ...(data.auth_pending > 0 ? [['Suppressions GoTrue en attente', data.auth_pending, '/admin/users'] as [string, number, string]] : []),
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
            {tiles.map(([label, n, href]) => (
              <li key={label} className="card-frame space-y-1 p-4">
                <p className="text-3xl font-bold tabular-nums">{formatInt(n)}</p>
                <Link href={href} className={link}>{label}</Link>
                {label.startsWith('Suppressions') && <p className="text-sm">Resynchroniser depuis la fiche du joueur</p>}
              </li>
            ))}
          </ul>
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
    </div>
  )
}
