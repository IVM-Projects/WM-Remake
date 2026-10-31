'use client'

import { ScrollText } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { ACTION_LABELS, TARGET_TYPES, type AuditPage, type AuditRow } from '@/components/admin/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { DataTable } from '@/components/ui/DataTable'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Pagination } from '@/components/ui/Pagination'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

const readable = (d: AuditPage | null): AuditPage | null => (d && Array.isArray(d.actions) && typeof d.hasMore === 'boolean' ? d : null)
const typeLabel = (t: string) => TARGET_TYPES.find((x) => x[0] === t)?.[1] ?? t
const FIELD = 'block min-h-11 w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'

// /admin/audit : journal des actions du staff, le plus récent d'abord. Filtres cumulés ; la réponse d'une page quittée est jetée (génération).
export function AuditClient() {
  const id = useId()
  const [type, setType] = useState('')
  const [draft, setDraft] = useState('')
  const [target, setTarget] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<AuditPage | null>(null)
  const [failed, setFailed] = useState(false)
  const gen = useRef(0)
  const refocus = useRef(false)
  const caption = useRef<HTMLTableCaptionElement>(null)
  const retry = useRef<HTMLButtonElement>(null)
  const h1 = useRef<HTMLHeadingElement>(null)

  const read = (t: string, id: string, p: number) => {
    const g = ++gen.current
    const q = new URLSearchParams({ page: String(p) })
    if (t) q.set('target_type', t)
    if (id) q.set('target_id', id)
    return api<AuditPage | null>(`/api/admin/audit?${q}`).then(readable, () => null).then((d) => {
      if (g !== gen.current) return
      setData(d)
      setFailed(!d)
    })
  }
  const onRead = useEffectEvent(() => { void read(type, target, page) })
  useEffect(() => { onRead() }, [type, target, page])
  useEffect(() => {
    if (!refocus.current || (!data && !failed)) return
    refocus.current = false
    ;(failed ? retry.current : (caption.current ?? h1.current))?.focus()
  }, [data, failed])

  // Rien ne change : l'effet de lecture ne rejoue pas, vider data laisserait « Chargement » à l'écran.
  const change = (t: string, id: string, p: number) => {
    if (t === type && id === target && p === page) return
    setType(t); setTarget(id); setPage(p); setData(null); setFailed(false)
  }

  return (
    <div data-ready={data || failed ? '' : undefined} className="space-y-6">
      <PageHeader ref={h1} title="Journal des actions" icon={ScrollText} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-type`} className="text-sm font-semibold">Type de cible</label>
          <select id={`${id}-type`} value={type} onChange={(e) => { const id = draft.trim(); setDraft(id); change(e.target.value, id, 0) }} className={FIELD}>
            <option value="">Tous</option>
            {TARGET_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-target`} className="text-sm font-semibold">Identifiant de cible</label>
          <input
            id={`${id}-target`}
            value={draft}
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(draft.trim()); change(type, draft.trim(), 0) } }}
            className={FIELD}
          />
        </div>
      </div>
      {!data ? (
        failed ? (
          <LoadError ref={retry} text="Le journal n'a pas pu être chargé." onRetry={() => { refocus.current = true; setFailed(false); void read(type, target, page) }} />
        ) : <Loading label="Chargement du journal" />
      ) : (
        <>
          {data.actions.length ? (
            <DataTable<AuditRow>
              caption="Journal des actions du staff, le plus récent d'abord"
              captionRef={caption}
              rows={data.actions}
              rowKey={(a) => String(a.id)}
              columns={[
                { key: 'date', header: 'Date', cellClassName: 'wrap-anywhere tabular-nums', cell: (a) => formatDateTime(a.created_at) },
                { key: 'staff', header: 'Membre du staff', cellClassName: 'wrap-anywhere', cell: (a) => (a.staff_id === null ? 'Système' : (a.staff_username ?? a.staff_id)) },
                { key: 'action', header: 'Action', cellClassName: 'wrap-anywhere', cell: (a) => ACTION_LABELS[a.action] ?? a.action },
                { key: 'target', header: 'Cible', cellClassName: 'wrap-anywhere', cell: (a) => `${typeLabel(a.target_type)} ${a.target_id}` },
                { key: 'reason', header: 'Motif', cellClassName: 'wrap-anywhere', cell: (a) => a.reason },
              ]}
            />
          ) : <p className="card-frame p-6 text-center text-sm">Aucune action enregistrée.</p>}
          <Pagination page={page} totalPages={null} more={data.hasMore} onPage={(p) => { refocus.current = true; change(type, target, p) }} />
        </>
      )}
    </div>
  )
}
