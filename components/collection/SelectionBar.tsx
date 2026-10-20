'use client'

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createTag } from '@/components/card/TagPicker'
import { ghost as ghostBase } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { WCoin } from '@/components/ui/WCoin'
import { apiOnce, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import type { TagCount } from './CollectionToolbar'

type Props = {
  ids: string[]
  // Grille en relecture ou en échec : ses copies sont celles de la requête d'avant, rien ne s'y applique.
  loading: boolean
  onSelectAll: () => void
  tags: TagCount[]
  tagsFailed: boolean
  // Étiquettes posées ou retirées : la page relit la grille et les nombres de copies.
  onTagged: () => void
  // Défausse finie (même en partie) : la page ne garde sélectionnées que `keep` (lots sans verdict) et relit grille, étiquettes et solde.
  onDiscarded: (keep: string[]) => void
}

type Action = 'apply' | 'remove' | 'discard'

// 0 et 1 au singulier, comme le veut le français.
const n = (count: number, one: string, many: string) => `${formatInt(count)} ${count > 1 ? many : one}`
const chunks = <T,>(xs: T[], size: number) => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size))

const ghost = `${ghostBase} gap-1.5`
const primary = 'inline-flex min-h-11 items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-not-allowed aria-disabled:opacity-80'
const field = 'w-full min-h-11 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'
// Irréversible : rouge plein, distinct d'« Annuler » (texte blanc ≥ 4,5:1 au repos, au survol et en cours, lib/contrast.test.ts).
const danger = 'inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800 aria-disabled:cursor-not-allowed aria-disabled:opacity-80'
const tagsError = <p role="alert" className="text-sm text-red-400">Tes étiquettes n&apos;ont pas pu être chargées.</p>
const BULK_UNSURE = 'La défausse n\'a pas été confirmée : une partie a peut-être eu lieu. Ton solde et ta collection se mettent à jour.'

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
  // Une Idempotency-Key par lot (ses copies), gardée tant que son issue est inconnue (apiOnce).
  const keys = useRef(new Map<string, string>())
  // Sélection laissée par la dernière défausse (onDiscarded(keep)) : ses clés ne valent que pour elle, toute autre est une nouvelle intention.
  const kept = useRef<string[] | null>(null)
  const none = ids.length === 0
  const off = none || loading
  const noTags = tagsFailed || !tags.length

  const open = (a: Action) => {
    if (off) return
    setError(null)
    setBlank(false)
    setAction(a)
  }

  // maybe : message d'un échec sans verdict du serveur (réseau, 5xx), quand l'action a pu avoir lieu.
  async function run(work: () => Promise<void>, failure: string, maybe = failure) {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } catch (e) {
      setError(userMessage(e, unsure(e) ? maybe : failure))
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
    // Même référence que keep : la relance de la sélection laissée ; sinon (même contenu resélectionné compris) les clés gardées ne servent plus.
    if (ids !== kept.current) keys.current.clear()
    let done = 0
    let failed = 0
    // Copies des lots qui ont reçu un verdict du serveur ; keep : celles qui restent sélectionnées pour la relance.
    let answered = 0
    let keep: string[] = []
    try {
      for (const part of chunks(ids, 50)) {
        const r = await apiOnce<{ discarded_count: number; failed?: unknown[] }>(keys.current, part.join(), '/api/user-cards/bulk-discard', {
          method: 'POST', body: JSON.stringify({ card_ids: part }),
        })
        // Réponse lue d'abord : un corps illisible (null) échoue ici, et ce lot reste dans keep.
        done += r.discarded_count
        failed += r.failed?.length ?? 0
        answered += part.length
      }
      if (failed) setError(`${n(failed, 'carte n\'a', 'cartes n\'ont')} pas pu être défaussée${failed > 1 ? 's' : ''}.`)
    } catch (e) {
      // Lot sans verdict : lui et les suivants restent sélectionnés ; relancé, ce lot garde sa clé et le serveur rejoue sa réponse.
      if (unsure(e)) keep = ids.slice(answered)
      throw e
    } finally {
      if (done) toast(`${n(done, 'carte défaussée', 'cartes défaussées')} : +${n(done, 'wikibidou', 'wikibidous')}`)
      kept.current = keep
      onDiscarded(keep)
    }
  }, 'La défausse s\'est arrêtée en cours de route.', BULK_UNSURE)

  const submit = (e: FormEvent, go: () => Promise<void>, off = false) => {
    e.preventDefault()
    if (!off) void go()
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
            <Actions off={busy} onCancel={() => setAction(null)}>Appliquer</Actions>
          </form>
        </Dialog>
      )}

      {action === 'remove' && (
        <Dialog id={id} title="Retirer l'étiquette" onClose={() => setAction(null)}>
          <form onSubmit={(e) => submit(e, remove, noTags)} className="space-y-4">
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
            {/* Aucune étiquette à retirer (ou illisibles) : « Retirer » ne fermerait la modale sur rien. */}
            <Actions off={busy || noTags} onCancel={() => setAction(null)}>Retirer</Actions>
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

function Actions({ off, onCancel, children }: { off: boolean; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-end gap-3">
      <button type="button" onClick={onCancel} className={ghost}>Annuler</button>
      <button type="submit" aria-disabled={off} className={primary}>{children}</button>
    </div>
  )
}
