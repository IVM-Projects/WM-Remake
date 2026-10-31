'use client'

import { Flag } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { ActionModal } from '@/components/admin/ActionModal'
import { DmThreadModal } from '@/components/admin/DmThreadModal'
import { SanctionModal } from '@/components/admin/SanctionModal'
import type { ImageRow, ReportRow, StaffRole } from '@/components/admin/types'
import { Card } from '@/components/card/Card'
import { PageHeader } from '@/components/shell/PageHeader'
import { ghost } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Pagination } from '@/components/ui/Pagination'
import { toast } from '@/components/ui/toast'
import { tabKey } from '@/components/ui/tabs'
import { api, apiOnce } from '@/lib/api'
import { formatDateTime, formatInt } from '@/lib/format'

const TABS = ['players', 'images'] as const
type Tab = (typeof TABS)[number]
const LABELS: Record<Tab, string> = { players: 'Joueurs', images: 'Images' }
type Status = 'open' | 'reviewed'
const REASONS: Record<string, string> = { cheating: 'Triche', inappropriate_content: 'Contenu inapproprié', spam: 'Spam' }
const EMPTY: Record<Tab, Record<Status, string>> = {
  players: { open: 'Aucun signalement à traiter.', reviewed: 'Aucun signalement traité.' },
  images: { open: 'Aucune image signalée.', reviewed: '' },
}
const FLAGS = {
  hide: { title: 'Masquer cette image ?', action: 'Masquer l\'image' },
  nsfw: { title: 'Marquer cette image comme sensible ?', action: 'Marquer sensible' },
  keep: { title: 'Garder cette image ?', action: 'Garder l\'image' },
} as const
type Mode = keyof typeof FLAGS

type View = { tab: 'players'; rows: ReportRow[]; hasMore: boolean } | { tab: 'images'; rows: ImageRow[]; hasMore: boolean }
type Open =
  | { k: 'dm'; r: ReportRow }
  | { k: 'sanction'; r: ReportRow; idx: number }
  | { k: 'review'; r: ReportRow; status: 'resolved' | 'dismissed'; idx: number }
  | { k: 'flags'; c: ImageRow; mode: Mode; idx: number }

const readable = (tab: Tab, d: unknown): View | null => {
  const o = d as { reports?: unknown; cards?: unknown; hasMore?: unknown } | null
  if (typeof o?.hasMore !== 'boolean') return null
  if (tab === 'players') return Array.isArray(o.reports) ? { tab, rows: o.reports as ReportRow[], hasMore: o.hasMore } : null
  return Array.isArray(o.cards) ? { tab, rows: o.cards as ImageRow[], hasMore: o.hasMore } : null
}
const who = (w: { username: string | null }) => w.username ?? 'Joueur supprimé'
const sized = 'card-frame space-y-3 p-4'

// /admin/reports : files de signalements de joueurs et d'images. La réponse d'une lecture quittée est jetée (génération) ; une ligne qui
// quitte la file rend le focus à l'action de la suivante, sinon au texte du vide.
export function ReportsClient({ role }: { role: StaffRole }) {
  const id = useId()
  const [tab, setTab] = useState<Tab>('players')
  const [status, setStatus] = useState<Status>('open')
  const [page, setPage] = useState(0)
  const [view, setView] = useState<View | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<Open | null>(null)
  const gen = useRef(0)
  const [keys] = useState(() => new Map<string, string>())
  const after = useRef<number | null>(null)
  const refocusTab = useRef(false)
  const list = useRef<HTMLUListElement>(null)
  const empty = useRef<HTMLParagraphElement>(null)
  const retry = useRef<HTMLButtonElement>(null)

  const read = (t: Tab, s: Status, p: number) => {
    const g = ++gen.current
    const url = t === 'players' ? `/api/admin/reports?${new URLSearchParams({ status: s, page: String(p) })}` : `/api/admin/image-reports?page=${p}`
    return api<unknown>(url).then((d) => readable(t, d), () => null).then((v) => {
      if (g !== gen.current) return
      setView(v)
      setFailed(!v)
    })
  }
  const onRead = useEffectEvent(() => { void read(tab, status, page) })
  useEffect(() => { onRead() }, [tab, status, page])

  useEffect(() => {
    if (!view && !failed) return
    if (refocusTab.current) {
      refocusTab.current = false
      ;(failed ? retry.current : document.getElementById(`${id}-tab-${tab}`))?.focus()
    } else if (after.current !== null && view) {
      const buttons = list.current?.querySelectorAll<HTMLElement>('[data-first-action]')
      ;(buttons?.length ? buttons[Math.min(after.current, buttons.length - 1)] : empty.current)?.focus()
      after.current = null
    }
  }, [view, failed, id, tab])

  const go = (t: Tab, s: Status, p: number, focus = false) => {
    if (t === tab && s === status && p === page) return
    refocusTab.current = focus
    setTab(t); setStatus(s); setPage(p); setView(null); setFailed(false)
  }
  // Action réussie : modale fermée, file relue (la ligne a pu la quitter).
  const done = (idx: number | null) => {
    after.current = idx
    setOpen(null)
    void read(tab, status, page)
  }

  const rows = view && view.tab === tab ? view : null
  return (
    <div data-ready={view || failed ? '' : undefined} className="space-y-6">
      <PageHeader title="Signalements" icon={Flag} />
      <div role="tablist" aria-label="Files de signalements" className="flex flex-nowrap gap-x-1 overflow-x-auto border-b border-[var(--color-border)]">
        {TABS.map((t) => (
          <button
            key={t}
            id={`${id}-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => go(t, 'open', 0)}
            onKeyDown={(e) => tabKey(e, TABS, tab, id, (n) => go(n, 'open', 0))}
            className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-4 text-sm font-semibold transition-colors focus-visible:-outline-offset-2 ${tab === t ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-b-2 border-transparent text-[var(--color-foreground)]/70 hover:text-[var(--color-foreground)]'}`}
          >
            {LABELS[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="space-y-4">
        {tab === 'players' && (
          <div className="flex flex-wrap gap-3">
            {(['open', 'reviewed'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => go('players', s, 0)} className={`${ghost}${status === s ? ' bg-[var(--color-surface-light)]' : ''}`}>
                {s === 'open' ? 'À traiter' : 'Traités'}
              </button>
            ))}
          </div>
        )}
        {!rows ? (
          failed ? (
            <LoadError ref={retry} text="Les signalements n'ont pas pu être chargés." onRetry={() => { refocusTab.current = true; after.current = null; setFailed(false); void read(tab, status, page) }} />
          ) : <Loading label="Chargement des signalements" />
        ) : (
          <>
            {rows.rows.length ? (
              <ul ref={list} className="space-y-3">
                {rows.tab === 'players' ? rows.rows.map((r, i) => (
                  <li key={r.id} className={sized}>
                    <p className="font-semibold">{REASONS[r.reason] ?? r.reason}</p>
                    {r.details && <p className="text-sm whitespace-pre-wrap wrap-anywhere">{r.details}</p>}
                    <p className="text-sm wrap-anywhere">{`${who(r.reporter)} a signalé ${who(r.reported)}`}</p>
                    <p className="text-sm text-[var(--color-foreground)]/70">
                      <time dateTime={r.created_at}>{formatDateTime(r.created_at)}</time>
                      {` · Sanctions actives de la cible : ${formatInt(r.active_sanctions)}`}
                    </p>
                    {r.review && (
                      <p className="text-sm wrap-anywhere">
                        {`${r.review.status === 'resolved' ? 'Traité' : 'Classé sans suite'} le ${formatDateTime(r.review.reviewed_at)} par ${r.review.reviewed_by_username ?? 'un membre du staff'}`}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-3">
                      <button type="button" data-first-action={status === 'reviewed' ? '' : undefined} onClick={() => setOpen({ k: 'dm', r })} className={ghost}>Lire les messages</button>
                      <button type="button" onClick={() => setOpen({ k: 'sanction', r, idx: i })} className={ghost}>Sanctionner</button>
                      {status === 'open' && (
                        <>
                          <button type="button" data-first-action="" onClick={() => setOpen({ k: 'review', r, status: 'resolved', idx: i })} className={ghost}>Marquer traité</button>
                          <button type="button" onClick={() => setOpen({ k: 'review', r, status: 'dismissed', idx: i })} className={ghost}>Classer sans suite</button>
                        </>
                      )}
                    </div>
                  </li>
                )) : rows.rows.map((c, i) => (
                  <li key={c.card_id} className={`${sized} flex flex-wrap items-start gap-4`}>
                    <Card card={{ wikipedia_title: c.wikipedia_title, rarity: 'C', image_url: c.image_url, hide_image: c.hide_image, nsfw_image: c.nsfw_image }} size="grid" />
                    <div className="min-w-0 flex-1 basis-48 space-y-2">
                      <p className="font-semibold wrap-anywhere">{c.wikipedia_title}</p>
                      <p className="text-sm">{`${formatInt(c.reports)} ${c.reports > 1 ? 'signalements' : 'signalement'}`}</p>
                      <p className="text-sm">{c.hide_image ? 'Masquée' : 'Visible'}{c.nsfw_image && ' · Sensible'}</p>
                      <div className="flex flex-wrap gap-3">
                        {!c.hide_image && <button type="button" data-first-action="" onClick={() => setOpen({ k: 'flags', c, mode: 'hide', idx: i })} className={ghost}>Masquer l&apos;image</button>}
                        {!c.nsfw_image && <button type="button" onClick={() => setOpen({ k: 'flags', c, mode: 'nsfw', idx: i })} className={ghost}>Marquer sensible</button>}
                        <button type="button" data-first-action={c.hide_image ? '' : undefined} onClick={() => setOpen({ k: 'flags', c, mode: 'keep', idx: i })} className={ghost}>Garder l&apos;image</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p ref={empty} tabIndex={-1} className="card-frame p-6 text-center text-sm outline-none">{EMPTY[tab][status]}</p>
            )}
            <Pagination page={page} totalPages={null} more={rows.hasMore} onPage={(p) => go(tab, status, p, true)} />
          </>
        )}
      </div>

      {open?.k === 'dm' && <DmThreadModal a={open.r.reporter} b={open.r.reported} keys={keys} onClose={() => setOpen(null)} />}
      {open?.k === 'sanction' && (
        <SanctionModal
          user={{ id: open.r.reported.id, username: who(open.r.reported) }}
          role={role}
          reportId={open.r.id}
          keys={keys}
          onDone={() => done(status === 'open' ? open.idx : null)}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.k === 'review' && (
        <ActionModal
          title={open.status === 'resolved' ? 'Marquer ce signalement comme traité ?' : 'Classer ce signalement sans suite ?'}
          consequence={open.status === 'resolved' ? 'Le signalement passe dans les traités, avec ton nom.' : 'Le signalement passe dans les traités, sans suite donnée.'}
          action={open.status === 'resolved' ? 'Marquer traité' : 'Classer sans suite'}
          tone="primary"
          onClose={() => setOpen(null)}
          onConfirm={async (reason) => {
            const body = JSON.stringify({ status: open.status, reason })
            const res = await apiOnce<{ ok?: boolean } | null>(keys, `review:${open.r.id}:${body}`, `/api/admin/reports/${open.r.id}/review`, { method: 'POST', body })
            if (!res) throw new Error('unreadable')
            toast('Signalement mis à jour.')
            done(status === 'open' ? open.idx : null)
          }}
        />
      )}
      {open?.k === 'flags' && (
        <ActionModal
          title={FLAGS[open.mode].title}
          consequence="Les signalements de cette carte sont effacés : le compteur repart de zéro."
          action={FLAGS[open.mode].action}
          tone={open.mode === 'keep' ? 'primary' : 'danger'}
          onClose={() => setOpen(null)}
          onConfirm={async (reason) => {
            const { c, mode } = open
            const body = JSON.stringify({ hide_image: mode === 'hide' ? true : mode === 'keep' ? false : c.hide_image, nsfw_image: mode === 'nsfw' ? true : c.nsfw_image, reason })
            const res = await apiOnce<{ card?: unknown } | null>(keys, `flags:${c.card_id}:${body}`, `/api/admin/cards/${c.card_id}/flags`, { method: 'POST', body })
            if (!res) throw new Error('unreadable')
            toast('Image mise à jour.')
            done(open.idx)
          }}
        />
      )}
    </div>
  )
}
