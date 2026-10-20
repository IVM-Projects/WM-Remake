'use client'

import { Bookmark, BookmarkCheck, Sparkles, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { WCoin } from '@/components/ui/WCoin'
import { api, ApiError } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { rarityOf, type RarityCode } from '@/lib/rarity'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import { Card, type CardFace } from './Card'
import { TagPicker, type Tag } from './TagPicker'

// Carte du catalogue (wm.cards_page, rest/v1/cards) ; q_score et pageviews manquent dans une copie de collection.
export type CatalogCard = CardFace & {
  id: string
  wikipedia_url: string
  summary?: string | null
  q_score?: number | null
  pageviews?: number | null
}

// Copie possédée (Item de wm.my_collection).
export type OwnedItem = {
  id: string
  card_id: string
  card: CatalogCard
  snapshot_title?: string
  snapshot_rarity?: RarityCode
  snapshot_category?: string | null
  snapshot_atk?: number
  snapshot_def?: number
  is_shiny: boolean
  starred: boolean
  count?: number
  tags: Tag[]
}

export type CardChange = { starred?: boolean; tags?: Tag[]; wishlisted?: boolean }

// Une copie s'affiche avec son snapshot (C11) : rareté, titre et stats figés au tirage.
export const faceOf = (i: OwnedItem): CardFace => ({
  ...i.card,
  wikipedia_title: i.snapshot_title ?? i.card.wikipedia_title,
  rarity: i.snapshot_rarity ?? i.card.rarity,
  category: i.snapshot_category ?? i.card.category,
  atk: i.snapshot_atk ?? i.card.atk,
  def: i.snapshot_def ?? i.card.def,
})

type Props = {
  item: OwnedItem | CatalogCard
  onClose: () => void
  onDiscarded?: (balance: number) => void
  onChanged?: (change: CardChange) => void
}

type Meta = Pick<CatalogCard, 'summary' | 'q_score' | 'pageviews'>

// Modale de carte (R§6.5). Copie possédée : étiquettes, favori et défausse ; catalogue : liste de souhaits.
export function CardModal({ item, onClose, onDiscarded, onChanged }: Props) {
  const owned = 'card' in item ? item : null
  const card = owned ? owned.card : (item as CatalogCard)
  const face = owned ? faceOf(owned) : card
  const r = rarityOf(face.rarity)
  const id = useId()
  const [tab, setTab] = useState<'details' | 'market'>('details')
  const [starred, setStarred] = useState(owned?.starred ?? false)
  const [tags, setTags] = useState(owned?.tags ?? [])
  const [meta, setMeta] = useState<Meta>({ summary: card.summary, q_score: card.q_score, pageviews: card.pageviews })
  const [wished, setWished] = useState<boolean | null>(null)
  // Jamais disabled sur un bouton qu'on vient de presser : le navigateur poserait le focus sur body (aria-disabled et garde à la place).
  const [busy, setBusy] = useState(false)
  const starring = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const needMeta = card.q_score === undefined || card.pageviews === undefined
  const isOwned = !!owned

  // À l'ouverture : la méta absente d'une copie (comme l'original, qui lit cards?id=eq.), l'état de la liste de souhaits d'une carte du catalogue.
  useEffect(() => {
    const sb = createBrowserSupabase()
    let live = true
    if (needMeta) {
      void sb.from('cards').select('summary,q_score,pageviews').eq('id', card.id).maybeSingle()
        .then(({ data }) => { if (live && data) setMeta(data as Meta) })
    }
    if (!isOwned) {
      // Lecture en échec : dit, et l'état reste inconnu (« Ajouter » reste sûr, un doublon revient en 23505).
      void sb.from('wishlist_items').select('card_id').eq('card_id', card.id).maybeSingle().then(({ data, error }) => {
        if (!live) return
        if (error) setError('Ta liste de souhaits n\'a pas pu être lue.')
        else setWished(!!data)
      })
    }
    return () => { live = false }
  }, [card.id, needMeta, isOwned])

  async function toggleStar() {
    // Un PATCH à la fois : un double clic laisserait l'écran et la base en désaccord.
    if (!owned || starring.current) return
    starring.current = true
    const next = !starred
    setStarred(next)
    // select('id') : une ligne que la RLS écarte n'est pas modifiée et ne revient pas, ce n'est pas un succès.
    const { data: rows, error } = await createBrowserSupabase().from('user_cards').update({ starred: next }).eq('id', owned.id).select('id')
    starring.current = false
    if (error || !rows?.length) {
      setStarred(!next)
      setError('Le favori n\'a pas pu être enregistré.')
    } else onChanged?.({ starred: next })
  }

  async function toggleWish() {
    if (busy) return
    const sb = createBrowserSupabase()
    setBusy(true)
    setError(null)
    const { data: auth } = await sb.auth.getSession()
    // select : une écriture que la RLS écarte ne renvoie aucune ligne, ce n'est pas un succès.
    const { data: rows, error } = wished
      ? await sb.from('wishlist_items').delete().eq('card_id', card.id).select('card_id')
      : await sb.from('wishlist_items').insert({ user_id: auth.session?.user.id, card_id: card.id }).select('card_id')
    setBusy(false)
    // 23505 : déjà dans la liste (autre onglet), l'état voulu est atteint.
    if (error?.code !== '23505' && (error || !rows?.length)) return setError('La liste de souhaits n\'a pas pu être mise à jour.')
    setWished(!wished)
    onChanged?.({ wishlisted: !wished })
  }

  async function discard() {
    if (!owned || busy) return
    setBusy(true)
    setError(null)
    try {
      const { balance } = await api<{ balance: number }>(`/api/user-cards/${owned.id}/discard`, { method: 'POST', idem: true })
      toast('Carte défaussée : +1 wikibidou')
      onDiscarded?.(balance)
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'La carte n\'a pas pu être défaussée.')
      setBusy(false)
    }
  }

  const tabKey = (e: KeyboardEvent) => {
    const next = { ArrowLeft: tab === 'details' ? 'market' : 'details', ArrowRight: tab === 'details' ? 'market' : 'details', Home: 'details', End: 'market' }[e.key] as typeof tab | undefined
    if (!next) return
    e.preventDefault()
    setTab(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }
  const tabProps = (t: typeof tab) => ({
    id: `${id}-tab-${t}`,
    type: 'button' as const,
    role: 'tab',
    'aria-selected': tab === t,
    'aria-controls': `${id}-panel`,
    tabIndex: tab === t ? 0 : -1,
    onClick: () => setTab(t),
    onKeyDown: tabKey,
    className: `inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors ${tab === t ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)]' : 'hover:bg-[var(--color-surface)]'}`,
  })

  return (
    <Modal
      onClose={onClose}
      labelledBy={`${id}-title`}
      className="card-frame relative w-full animate-fade-in-up p-6 pt-14 sm:pt-6 max-w-2xl max-h-[90vh] overflow-y-auto"
    >
      <button
        type="button"
        aria-label="Fermer"
        onClick={onClose}
        className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-light)]"
      >
        <X className="size-6" />
      </button>
      <div className="flex flex-col md:flex-row gap-6">
        <div className="flex-shrink-0 flex justify-center">
          <Card
            card={face}
            owned={!!owned}
            starred={starred}
            onToggleStar={owned ? () => void toggleStar() : undefined}
            count={owned?.count}
            isShiny={owned?.is_shiny}
            excerpt={meta.summary}
          />
        </div>
        <div className="flex-1 flex flex-col min-w-0 md:pr-2 gap-4">
          <div className="md:pr-10">
            <h2 id={`${id}-title`} className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              {face.wikipedia_title}
            </h2>
            <p className="text-sm font-semibold" style={{ color: `var(--color-rarity-${r.css})` }}>
              {r.label}
              {owned?.is_shiny && ' · Brillante'}
            </p>
          </div>
          <div role="tablist" aria-label="Vue de la carte" className="flex gap-1 rounded-xl bg-[var(--color-surface-light)] p-1">
            <button {...tabProps('details')}>Détails</button>
            <button {...tabProps('market')}>
              Marché
              <span
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${tab === 'market' ? 'bg-[var(--color-accent-foreground)] text-violet-300' : 'bg-violet-500/20 text-violet-300'}`}
              >
                <Sparkles className="size-3" />
                PRO
              </span>
            </button>
          </div>
          <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="flex flex-col gap-4">
            {tab === 'market' ? (
              <p className="text-sm text-[var(--color-foreground)]/70">Arrive bientôt</p>
            ) : (
              <>
                {face.category && <p className="text-sm text-[var(--color-foreground)]/70">{face.category}</p>}
                {owned ? (
                  <section aria-labelledby={`${id}-tags`} className="space-y-2">
                    <h3 id={`${id}-tags`} className="text-xs font-bold tracking-wider text-[var(--color-foreground)]/60">ÉTIQUETTES</h3>
                    <TagPicker
                      userCardId={owned.id}
                      tags={tags}
                      onChange={(t) => {
                        setTags(t)
                        onChanged?.({ tags: t })
                      }}
                    />
                  </section>
                ) : (
                  // État encore inconnu = absent : un ajout en double revient en 23505, traité comme réussi.
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => void toggleWish()}
                    className={`inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-xl px-4 text-sm font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-45 ${wished ? 'border border-[var(--color-foreground)]/40 hover:bg-[var(--color-surface-light)]' : 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/15'}`}
                  >
                    {wished ? <BookmarkCheck className="size-4 text-[var(--color-accent)]" /> : <Bookmark className="size-4" />}
                    {wished ? 'Retirer de ma liste de souhaits' : 'Ajouter à ma liste de souhaits'}
                  </button>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="ATK" tone="text-red-400">{formatInt(face.atk ?? 0)}</Stat>
                  <Stat label="DEF" tone="text-blue-400">{formatInt(face.def ?? 0)}</Stat>
                </div>
                {/* Bloc méta : /60 et non le /30 d'origine (règle du plancher, docs/DESIGN.md). */}
                <div className="space-y-1 text-xs text-[var(--color-foreground)]/60">
                  {/* Q-Score avec un point comme l'original (R19) : les extensions le lisent. */}
                  {meta.q_score != null && <p>Q-Score : {Number(meta.q_score).toFixed(2)}</p>}
                  {owned && <p>Exemplaires : {formatInt(owned.count ?? 1)}</p>}
                  {meta.pageviews != null && <p>Vues (30j) : {formatInt(meta.pageviews)}</p>}
                  <p className="pt-1">
                    <a
                      href={card.wikipedia_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[var(--color-accent-light)] underline-offset-2 hover:underline"
                    >
                      Voir l&apos;article sur Wikipédia →
                    </a>
                  </p>
                  {/* shortcut: auteur et licence de l'image (/api/cards/{id}/credits, D§8.5) quand la route existera. */}
                  <p>Texte de l&apos;article : CC BY-SA 4.0 — crédits sur la page Wikipédia.</p>
                </div>
              </>
            )}
          </div>
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          {owned && (
            <div className="mt-auto flex flex-wrap gap-3 border-t border-[var(--color-border)] pt-4">
              <button
                type="button"
                aria-disabled={busy}
                onClick={() => void discard()}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)] aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
              >
                Défausser
                <WCoin />
                +1
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function Stat({ label, tone, children }: { label: string; tone: string; children: ReactNode }) {
  return (
    <div className="card-frame p-3">
      <p className="text-xs font-medium text-[var(--color-foreground)]/60">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${tone}`}>{children}</p>
    </div>
  )
}
