'use client'

import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { createTag } from '@/components/card/TagPicker'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { WCoin } from '@/components/ui/WCoin'
import { api, ApiError } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import type { TagCount } from './CollectionToolbar'

type Props = {
  ids: string[]
  // Grille en relecture (aria-busy) : ses copies sont celles de la requête d'avant, rien ne s'y applique.
  loading: boolean
  onSelectAll: () => void
  tags: TagCount[]
  tagsFailed: boolean
  // Étiquettes posées ou retirées : la page relit la grille et les nombres de copies.
  onTagged: () => void
  // Défausse finie (même en partie) : la page vide la sélection et relit grille, étiquettes et solde.
  onDiscarded: () => void
}

type Action = 'apply' | 'remove' | 'discard'

// 0 et 1 au singulier, comme le veut le français.
const n = (count: number, one: string, many: string) => `${formatInt(count)} ${count > 1 ? many : one}`
const chunks = <T,>(xs: T[], size: number) => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size))

const ghost = 'inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)] aria-disabled:cursor-not-allowed aria-disabled:border-[var(--color-border)] aria-disabled:text-[var(--color-foreground)]/60 aria-disabled:hover:bg-transparent'
const primary = 'inline-flex min-h-11 items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-not-allowed aria-disabled:opacity-80'
const field = 'w-full min-h-11 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'
// Irréversible : rouge plein, distinct d'« Annuler » (texte blanc ≥ 4,5:1 au repos, au survol et en cours, lib/contrast.test.ts).
const danger = 'inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800 aria-disabled:cursor-not-allowed aria-disabled:opacity-80'
const tagsError = <p role="alert" className="text-sm text-red-400">Tes étiquettes n&apos;ont pas pu être chargées.</p>

// Multi-sélection (R§2.2) : étiquette appliquée ou retirée en direct par PostgREST (lots de 100, R§3.3), défausse en masse par lots de 50.
export function SelectionBar({ ids, loading, onSelectAll, tags, tagsFailed, onTagged, onDiscarded }: Props) {
  const id = useId()
  const [action, setAction] = useState<Action | null>(null)
  const [name, setName] = useState('')
  const [tagId, setTagId] = useState('')
  // Jamais disabled sur le bouton pressé (le focus tomberait sur body) : aria-disabled et une garde.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blank, setBlank] = useState(false)
  const none = ids.length === 0
  const off = none || loading

  const open = (a: Action) => {
    if (off) return
    setError(null)
    setBlank(false)
    setAction(a)
  }

  async function run(work: () => Promise<void>, failure: string) {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : failure)
    } finally {
      setBusy(false)
      setAction(null)
    }
  }

  const apply = () => {
    // Que des espaces : la modale reste ouverte et le dit.
    if (!name.trim()) {
      setBlank(true)
      return Promise.resolve()
    }
    return applyNamed()
  }
  const applyNamed = () => run(async () => {
    const label = name.trim()
    const sb = createBrowserSupabase()
    try {
      const tag = tags.find((t) => t.name.toLowerCase() === label.toLowerCase()) ?? await createTag(label)
      for (const part of chunks(ids, 100)) {
        const { error } = await sb.from('user_card_tags')
          .upsert(part.map((c) => ({ user_card_id: c, tag_id: tag.id })), { onConflict: 'user_card_id,tag_id', ignoreDuplicates: true })
        if (error) throw error
      }
      toast(`Étiquette « ${tag.name} » appliquée à ${n(ids.length, 'carte', 'cartes')}`)
    } finally {
      setName('')
      onTagged()
    }
  }, 'L\'étiquette n\'a pas pu être appliquée à toutes les cartes.')

  const remove = () => run(async () => {
    const tag = tags.find((t) => t.id === tagId)
    if (!tag) return
    const sb = createBrowserSupabase()
    try {
      for (const part of chunks(ids, 100)) {
        const { error } = await sb.from('user_card_tags').delete().eq('tag_id', tag.id).in('user_card_id', part)
        if (error) throw error
      }
      toast(`Étiquette « ${tag.name} » retirée`)
    } finally {
      onTagged()
    }
  }, 'L\'étiquette n\'a pas pu être retirée de toutes les cartes.')

  const discard = () => run(async () => {
    let done = 0
    let failed = 0
    try {
      for (const part of chunks(ids, 50)) {
        const r = await api<{ discarded_count: number; failed?: unknown[] }>('/api/user-cards/bulk-discard', {
          method: 'POST', idem: true, body: JSON.stringify({ card_ids: part }),
        })
        done += r.discarded_count
        failed += r.failed?.length ?? 0
      }
      if (failed) setError(`${n(failed, 'carte n\'a', 'cartes n\'ont')} pas pu être défaussée${failed > 1 ? 's' : ''}.`)
    } finally {
      if (done) toast(`${n(done, 'carte défaussée', 'cartes défaussées')} : +${n(done, 'wikibidou', 'wikibidous')}`)
      onDiscarded()
    }
  }, 'La défausse s\'est arrêtée en cours de route.')

  const submit = (e: FormEvent, go: () => Promise<void>) => {
    e.preventDefault()
    void go()
  }

  return (
    <div className="space-y-2">
      <div className="card-frame flex flex-wrap items-center gap-3 p-3">
        <p aria-live="polite" className="text-sm font-medium tabular-nums">
          {none ? 'Aucune carte sélectionnée' : n(ids.length, 'carte sélectionnée', 'cartes sélectionnées')}
        </p>
        <button type="button" aria-disabled={loading} onClick={() => { if (!loading) onSelectAll() }} className={ghost}>Tout sélectionner</button>
        <button type="button" aria-disabled={off} onClick={() => open('apply')} className={ghost}>Appliquer une étiquette</button>
        <button type="button" aria-disabled={off} onClick={() => open('remove')} className={ghost}>Retirer l&apos;étiquette</button>
        <button type="button" aria-disabled={off} onClick={() => open('discard')} className={ghost}>Défausser</button>
      </div>
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}

      {action === 'apply' && (
        <Dialog id={id} title="Appliquer une étiquette" onClose={() => setAction(null)}>
          <form onSubmit={(e) => submit(e, apply)} className="space-y-4">
            <p className="text-sm text-[var(--color-foreground)]/70">À {n(ids.length, 'carte sélectionnée', 'cartes sélectionnées')}.</p>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-name`} className="text-sm font-medium">Étiquette</label>
              <input
                id={`${id}-name`}
                list={`${id}-tags`}
                required
                maxLength={48}
                value={name}
                aria-invalid={blank}
                aria-describedby={blank ? `${id}-blank` : undefined}
                onChange={(e) => {
                  setName(e.target.value)
                  setBlank(false)
                }}
                className={field}
              />
              <datalist id={`${id}-tags`}>{tags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
              {blank && <p id={`${id}-blank`} role="alert" className="text-sm text-red-400">Le nom de l&apos;étiquette ne peut pas être vide.</p>}
            </div>
            {tagsFailed && tagsError}
            <Actions busy={busy} onCancel={() => setAction(null)}>Appliquer</Actions>
          </form>
        </Dialog>
      )}

      {action === 'remove' && (
        <Dialog id={id} title="Retirer l'étiquette" onClose={() => setAction(null)}>
          <form onSubmit={(e) => submit(e, remove)} className="space-y-4">
            <p className="text-sm text-[var(--color-foreground)]/70">Des {n(ids.length, 'carte sélectionnée', 'cartes sélectionnées')}.</p>
            {tagsFailed ? tagsError : tags.length ? (
              <div className="space-y-1.5">
                <label htmlFor={`${id}-tag`} className="text-sm font-medium">Étiquette</label>
                <select id={`${id}-tag`} required value={tagId} onChange={(e) => setTagId(e.target.value)} className={field}>
                  <option value="">Choisir une étiquette</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            ) : (
              <p className="text-sm">Tu n&apos;as encore aucune étiquette.</p>
            )}
            <Actions busy={busy} onCancel={() => setAction(null)}>Retirer</Actions>
          </form>
        </Dialog>
      )}

      {action === 'discard' && (
        <Dialog id={id} title={`Défausser ${n(ids.length, 'carte', 'cartes')} ?`} onClose={() => setAction(null)}>
          <p className="text-sm">Tu gagneras {n(ids.length, 'wikibidou', 'wikibidous')}. Action irréversible.</p>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={() => setAction(null)} className={ghost}>Annuler</button>
            <button type="button" aria-disabled={busy} onClick={() => void discard()} className={danger}>
              Défausser
              <WCoin />
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

function Dialog({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal onClose={onClose} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-md animate-fade-in-up space-y-4 p-6">
      <h2 id={`${id}-title`} className="text-xl font-bold">{title}</h2>
      {children}
    </Modal>
  )
}

function Actions({ busy, onCancel, children }: { busy: boolean; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-end gap-3">
      <button type="button" onClick={onCancel} className={ghost}>Annuler</button>
      <button type="submit" aria-disabled={busy} className={primary}>{children}</button>
    </div>
  )
}
