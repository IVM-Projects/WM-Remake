'use client'

import { useId, useRef, useState, type FormEvent } from 'react'
import { Card } from '@/components/card/Card'
import type { CatalogCard } from '@/components/card/CardModal'
import { ghost } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'

const field = 'min-h-11 w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm'

// Choix d'une carte du catalogue à demander à la guilde : recherche envoyée sur Entrée (2 caractères au moins, comme le catalogue), première
// page de /api/cards?q=… seulement. onPick lève le texte d'un refus ou d'une issue incertaine : la modale le montre et reste ouverte
// (modèle CardPicker).
export function CatalogPicker({ onPick, onClose }: { onPick: (cardId: string, title: string) => Promise<void>; onClose: () => void }) {
  const id = useId()
  const [cards, setCards] = useState<CatalogCard[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Un choix à la fois, jusqu'à sa réponse : garde, et ni Échap, ni voile, ni « Annuler ».
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  // Génération : la réponse d'une recherche quittée est jetée.
  const gen = useRef(0)
  const title = useRef<HTMLHeadingElement>(null)

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim()
    const g = ++gen.current
    setCards(null)
    if ([...q].length < 2) {
      setLoading(false)
      return setError('Tape au moins 2 caractères.')
    }
    setError(null)
    setLoading(true)
    void api<{ cards: CatalogCard[] } | null>(`/api/cards?${new URLSearchParams({ q })}`)
      .then((r) => (Array.isArray(r?.cards) ? r.cards : null), () => null)
      .then((r) => {
        if (g !== gen.current) return
        setLoading(false)
        if (r) setCards(r)
        else setError('La recherche n\'a pas abouti.')
      })
  }

  async function pick(c: CatalogCard) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      // Réussi : l'appelant ferme la modale.
      await onPick(c.id, c.wikipedia_title)
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

  return (
    <Modal onClose={close} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-3xl animate-fade-in-up space-y-4 p-6 max-h-[90vh] overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={title} id={`${id}-title`} tabIndex={-1} className="text-xl font-bold outline-none">Choisir une carte à demander</h2>
        <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
      </div>
      <form role="search" onSubmit={search}>
        <input type="search" name="q" aria-label="Rechercher une carte" className={field} />
      </form>
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      {loading ? (
        <Loading label="Recherche en cours" />
      ) : cards ? (
        cards.length ? (
          <ul className="flex flex-wrap justify-center gap-3">
            {cards.map((c) => (
              <li key={c.id}>
                <Card card={c} size="grid" onClick={() => void pick(c)} clickOff={busy} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-foreground)]/70">Aucune carte trouvée.</p>
        )
      ) : null}
    </Modal>
  )
}
