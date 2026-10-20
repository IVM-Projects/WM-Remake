'use client'

import { Bookmark } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Card } from '@/components/card/Card'
import { CardModal, type CatalogCard } from '@/components/card/CardModal'
import { Loading } from '@/components/ui/Loading'
import { Pagination } from '@/components/ui/Pagination'
import { RarityChips } from '@/components/ui/RarityChips'
import { api } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { RARITY, type RarityCode } from '@/lib/rarity'

const LIMIT = 50

// Réponse de wm.cards_page (R§3.4) : total null et pas de rarityCounts pendant une recherche.
type CardsPage = { cards: CatalogCard[]; total: number | null; rarityCounts?: Partial<Record<RarityCode, number>>; searchHasMore?: boolean }
type Query = { q?: string; rarity?: RarityCode[]; wishlist?: boolean }

// Singulier pour 0 et 1, comme en français.
const cartes = (n: number) => `${formatInt(n)} carte${n > 1 ? 's' : ''}`

const control = 'min-h-11 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'
const ghost = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)] aria-disabled:cursor-not-allowed aria-disabled:border-[var(--color-border)] aria-disabled:text-[var(--color-foreground)]/60 aria-disabled:hover:bg-transparent'

// Catalogue complet (R§2.2) : recherche serveur, raretés, liste de souhaits, 50 cartes par page.
// shortcut: état en mémoire et non dans l'adresse ; un rechargement revient à la première page — le passer en ?page/q/rarity/wishlist si on le demande.
export function GlobalClient() {
  const [page, setPage] = useState(0)
  const [q, setQ] = useState('')
  const [text, setText] = useState('')
  const [tooShort, setTooShort] = useState(false)
  const [rarity, setRarity] = useState<RarityCode[]>([])
  const [wishlist, setWishlist] = useState(false)
  const [reload, setReload] = useState(0)
  const sp = new URLSearchParams({ page: String(page), sort: 'rarity' })
  if (q) sp.set('q', q)
  for (const r of rarity) sp.append('rarity', r)
  if (wishlist) sp.set('wishlist', '1')
  const query = sp.toString()
  const key = `${query}#${reload}`

  const [data, setData] = useState<(CardsPage & { key: string }) | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [open, setOpen] = useState<CatalogCard | null>(null)
  // La modale a changé la liste de souhaits affichée : relecture à sa fermeture.
  const dirty = useRef(false)
  // Rang à refocaliser si le focus tombe sur body (tuile, panneau ou bouton retirés par la relecture) ; null : rien d'attendu.
  const refocus = useRef<number | null>(null)
  const results = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const empty = useRef<HTMLDivElement>(null)
  const retry = useRef<HTMLButtonElement>(null)

  const items = data?.cards ?? []
  const failed = failedKey === key
  // stale : la grille affichée n'est pas celle de la requête courante (relecture en cours ou en échec).
  const stale = data?.key !== key
  const filtered = !!(q || rarity.length)

  // Page vidée (dernier souhait d'une page retiré) : la dernière page qui existe ; toujours en recul, donc fini.
  if (data && !stale && !data.cards.length && page > 0) {
    setPage(Math.min(page - 1, data.total === null ? page - 1 : Math.max(0, Math.ceil(data.total / LIMIT) - 1)))
  }

  useEffect(() => {
    let live = true
    api<CardsPage>(`/api/cards?${query}`)
      .then((r) => { if (live) setData({ ...r, key }) })
      .catch(() => { if (live) setFailedKey(key) })
    // Nouvelle requête : l'échec d'avant s'efface.
    return () => {
      live = false
      setFailedKey(null)
    }
  }, [key, query])

  useEffect(() => {
    if (!failed && stale) return
    const i = refocus.current
    refocus.current = null
    const active = document.activeElement
    if (i === null || (active && active !== document.body && active !== results.current)) return
    const tiles = grid.current?.querySelectorAll<HTMLElement>('h3 > button')
    ;(failed ? retry.current : tiles?.length ? tiles[Math.min(i, tiles.length - 1)] : empty.current)?.focus()
  }, [failed, stale, data, open]) // open : fermer la modale sur une grille déjà relue rend aussi le focus.

  // Tout changement de requête repart de la première page.
  function change(next: Query) {
    refocus.current = 0
    setPage(0)
    if (next.q !== undefined) setQ(next.q)
    if (next.rarity) setRarity(next.rarity)
    if (next.wishlist !== undefined) setWishlist(next.wishlist)
  }

  // Bouton d'un panneau qui disparaît avec lui : le focus attend sur la zone des résultats, jamais sur body.
  const fromPanel = (fn: () => void) => {
    results.current?.focus()
    fn()
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const v = text.trim()
    if (!v) return
    // Seuil du serveur (wm.cards_page) en caractères, pas en unités UTF-16.
    if ([...v].length < 2) return setTooShort(true)
    change({ q: v })
  }

  function onText(v: string) {
    setText(v)
    setTooShort(false)
    // Champ vidé (croix du champ de recherche comprise) : retour au catalogue entier.
    if (!v.trim() && q) change({ q: '' })
  }

  function clearFilters() {
    setText('')
    setTooShort(false)
    change({ q: '', rarity: [] })
  }

  function closeModal() {
    // Grille périmée : la place de la carte dans la grille de la requête est inconnue.
    refocus.current = Math.max(0, stale ? -1 : items.findIndex((c) => c.id === open?.id))
    if (dirty.current) {
      dirty.current = false
      setReload((r) => r + 1)
    }
    setOpen(null)
  }

  return (
    <>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <form role="search" onSubmit={submit} className="flex w-full min-w-0 gap-2 sm:w-auto sm:flex-1 sm:basis-80">
            <input
              type="search"
              aria-label="Rechercher une carte"
              placeholder="Rechercher une carte…"
              value={text}
              onChange={(e) => onText(e.target.value)}
              aria-invalid={tooShort || undefined}
              aria-describedby={tooShort ? 'gc-search-error' : undefined}
              className={`${control} min-w-0 flex-1 py-2.5 placeholder:text-[var(--color-foreground)]/60`}
            />
            {/* aria-disabled et une garde (submit) : jamais disabled sous le focus. */}
            <button type="submit" aria-disabled={!text.trim()} className={ghost}>Rechercher</button>
          </form>
          {/* Un seul tri côté serveur (sort=rarity, R§3.4) : la liste le montre sans en promettre d'autre. */}
          <select aria-label="Trier les cartes" className={control}>
            <option value="rarity">Rareté</option>
          </select>
          <button
            type="button"
            aria-pressed={wishlist}
            onClick={() => change({ wishlist: !wishlist })}
            className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors ${wishlist ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-light)]' : 'border border-[var(--color-foreground)]/40 hover:bg-[var(--color-surface-light)]'}`}
          >
            <Bookmark className="size-4" />
            Liste de souhaits
          </button>
        </div>
        {tooShort && <p id="gc-search-error" role="alert" className="text-sm font-medium text-red-400">La recherche demande au moins 2 caractères</p>}
        <RarityChips value={rarity} onChange={(v) => change({ rarity: v })} />
      </div>

      {data && !failed && (
        <div className="card-frame p-4 text-sm">
          {data.total === null ? (
            <p>Recherche active : pas de décompte par rareté ni de total exact</p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              {data.rarityCounts && (
                <ul aria-label="Cartes par rareté" className="flex flex-wrap gap-x-4 gap-y-1 font-semibold tabular-nums">
                  {RARITY.map((r) => (
                    <li key={r.code} title={r.label} style={{ color: `var(--color-rarity-${r.css})` }}>
                      <span aria-hidden="true">{r.code}</span>
                      <span className="sr-only">{r.label}</span> {formatInt(data.rarityCounts?.[r.code] ?? 0)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="font-semibold">{data.rarityCounts ? `${cartes(data.total)} au total` : `${cartes(data.total)} dans ta liste de souhaits`}</p>
            </div>
          )}
        </div>
      )}

      <div ref={results} tabIndex={-1} className="space-y-6 outline-none">
        {failed ? (
          <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
            <p role="alert" className="text-sm">Les cartes n&apos;ont pas pu être chargées.</p>
            <div className="flex flex-wrap justify-center gap-3">
              <button
                ref={retry}
                type="button"
                onClick={() => fromPanel(() => {
                  refocus.current = 0
                  setReload((r) => r + 1)
                })}
                className={ghost}
              >
                Réessayer
              </button>
              {filtered && <button type="button" onClick={() => fromPanel(clearFilters)} className={ghost}>Effacer les filtres</button>}
            </div>
          </div>
        ) : !data ? (
          <Loading label="Chargement des cartes" />
        ) : items.length === 0 ? (
          <div ref={empty} tabIndex={-1} className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-8 text-center outline-none">
            {filtered ? (
              <>
                <p className="font-semibold">Aucune carte ne correspond à ces filtres.</p>
                <button type="button" onClick={() => fromPanel(clearFilters)} className={ghost}>Effacer les filtres</button>
              </>
            ) : wishlist ? (
              <>
                <Bookmark className="size-8 text-[var(--color-accent)]" aria-hidden="true" />
                <p className="text-lg font-semibold">Ta liste de souhaits est vide</p>
                <p className="text-sm text-[var(--color-foreground)]/70">Ouvre une carte du catalogue et ajoute-la à ta liste de souhaits.</p>
                <button type="button" onClick={() => fromPanel(() => change({ wishlist: false }))} className={ghost}>Voir tout le catalogue</button>
              </>
            ) : (
              <p className="font-semibold">Le catalogue est vide pour l&apos;instant.</p>
            )}
          </div>
        ) : (
          <>
            <div ref={grid} aria-busy={stale} className="flex flex-wrap justify-center gap-3 sm:gap-[22px] md:gap-[26px]">
              {items.map((c) => <Card key={c.id} card={c} size="grid" onClick={() => setOpen(c)} />)}
            </div>
            <Pagination
              page={page}
              totalPages={data.total === null ? null : Math.ceil(data.total / LIMIT)}
              more={data.searchHasMore}
              onPage={(p) => {
                refocus.current = 0
                setPage(p)
                document.querySelector('main')?.scrollTo({ top: 0 })
              }}
            />
          </>
        )}
      </div>

      {open && (
        <CardModal
          item={open}
          onClose={closeModal}
          onChanged={(c) => { if (c.wishlisted !== undefined && wishlist) dirty.current = true }}
        />
      )}
    </>
  )
}
