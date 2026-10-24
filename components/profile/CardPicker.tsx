'use client'

import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from 'react'
import { Card, showsImage } from '@/components/card/Card'
import { faceOf, type OwnedItem } from '@/components/card/CardModal'
import { ghost } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'

const PAGE = 50
const field = 'min-h-11 w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm'
type List = { page: number; items: OwnedItem[]; total: number }

// Choix d'une de ses copies (/profile), lues par pages de 50 dans /api/my-collection. Avatar : une copie sans image utilisable (M4b-6) reste
// visible, sans clic, légendée « Sans image ». onPick lève le texte d'un refus ou d'une issue incertaine : la modale le montre et reste ouverte.
export function CardPicker({ mode, onPick, onClose }: { mode: 'avatar' | 'showcase'; onPick: (userCardId: string) => Promise<void>; onClose: () => void }) {
  const id = useId()
  const [list, setList] = useState<List | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Un choix à la fois, jusqu'à sa réponse : garde, et ni Échap, ni voile, ni « Annuler ».
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  // Génération : la réponse d'un filtre ou d'une page quittés est jetée.
  const gen = useRef(0)
  // Filtre appliqué (envoyé sur Entrée) : relu par « Réessayer », « Charger la suite » et chaque affichage, même quand sa lecture a échoué.
  const q = useRef('')
  const title = useRef<HTMLHeadingElement>(null)
  const cards = useRef<HTMLUListElement>(null)
  // Rang de la première copie attendue de « Charger la suite » : sur la dernière page, le bouton disparaît sous le focus, qui va à elle.
  const refocus = useRef<number | null>(null)

  // Page 0 : la liste remplacée ; suivante : ajoutée, sans reprendre une copie déjà listée (pages par décalage). Échec ou 2xx sans
  // `collection` (corps illisible : api() rend null) : page 0, l'alerte et « Réessayer » à la place de la grille ; suivante, les pages
  // lues restent et l'alerte le dit (comme TradeComposer).
  const read = (page: number) => {
    const g = ++gen.current
    const text = q.current
    void api<{ collection: OwnedItem[]; total: number } | null>(`/api/my-collection?${new URLSearchParams({ ...(text ? { q: text } : {}), page: String(page) })}`)
      .then((r) => (Array.isArray(r?.collection) ? r : null), () => null)
      .then((r) => {
        if (g !== gen.current) return
        setLoading(false)
        if (!r && page) return setError('Impossible de charger cette page.')
        setFailed(!r)
        if (r) setList((l) => ({ page, total: r.total, items: page && l ? [...l.items, ...r.collection.filter((c) => !l.items.some((x) => x.id === c.id))] : r.collection }))
      })
  }

  useEffect(() => {
    const i = refocus.current
    if (i === null || loading) return
    refocus.current = null
    const a = document.activeElement
    if (a !== document.body && !a?.matches('[role="dialog"]')) return
    const next = [...(cards.current?.children ?? [])].slice(i).map((li) => li.querySelector<HTMLElement>('h3 > button')).find(Boolean)
    ;(next ?? title.current)?.focus()
  }, [list, loading])
  // Lue à l'ouverture et à chaque affichage (Activity compris), sous le filtre appliqué.
  const onShow = useEffectEvent(() => read(0))
  useEffect(() => onShow(), [])

  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    q.current = String(new FormData(e.currentTarget).get('q') ?? '').trim()
    setList(null)
    read(0)
  }

  async function pick(userCardId: string) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      // Réussi : l'appelant ferme la modale.
      await onPick(userCardId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const close = () => {
    if (!inflight.current) onClose()
  }

  const heading = mode === 'avatar' ? 'Choisir ton avatar' : 'Choisir une carte pour la vitrine'
  return (
    <Modal onClose={close} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-3xl animate-fade-in-up space-y-4 p-6 max-h-[90vh] overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={title} id={`${id}-title`} tabIndex={-1} className="text-xl font-bold outline-none">{heading}</h2>
        <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
      </div>
      {/* Envoi sur Entrée (un seul champ : soumission implicite). */}
      <form role="search" onSubmit={filter}>
        <input type="search" name="q" aria-label="Filtrer mes cartes" className={field} />
      </form>
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      {failed ? (
        // « Réessayer » disparaît pendant la relecture : le focus passe au titre, jamais sur body.
        <LoadError onRetry={() => {
          title.current?.focus()
          setFailed(false)
          read(0)
        }} />
      ) : !list ? (
        <Loading label="Chargement de la collection" />
      ) : list.items.length ? (
        <>
          <ul ref={cards} className="flex flex-wrap justify-center gap-3">
            {list.items.map((c) => {
              const usable = mode === 'showcase' || showsImage(c.card, true)
              return (
                <li key={c.id} className="flex flex-col items-center gap-1">
                  <Card card={faceOf(c)} size="grid" count={c.count} isShiny={c.is_shiny} onClick={usable ? () => void pick(c.id) : undefined} clickOff={busy} />
                  {!usable && <p className="text-xs text-[var(--color-foreground)]/70">Sans image</p>}
                </li>
              )
            })}
          </ul>
          {(list.page + 1) * PAGE < list.total && (
            <button type="button" aria-disabled={loading || undefined} onClick={() => {
              if (loading) return
              setLoading(true)
              setError(null)
              refocus.current = list.items.length
              read(list.page + 1)
            }} className={`${ghost} justify-center`}>
              Charger la suite
            </button>
          )}
        </>
      ) : (
        <p className="text-sm text-[var(--color-foreground)]/70">Aucune carte.</p>
      )}
    </Modal>
  )
}
