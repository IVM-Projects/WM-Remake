'use client'

import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AuctionTile } from '@/components/market/AuctionTile'
import type { Auction, MineLists } from '@/components/market/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { ghost } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { RarityChips } from '@/components/ui/RarityChips'
import { toast } from '@/components/ui/toast'
import { api, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { usePoll } from '@/lib/poll'
import type { RarityCode } from '@/lib/rarity'

const entry = navEntry('/marketplace')
// Pages de 50 (P17) ; la liste de l'onglet visible est relue toutes les 15 s (C15, D§9.5).
const PAGE = 50
const POLL_MS = 15_000
const TABS = ['browse', 'selling', 'bidding', 'won', 'history'] as const
type Tab = (typeof TABS)[number]
type MineTab = Exclude<Tab, 'browse'>
type Page = { items: Auction[]; more: boolean }

const SORTS = [['recent', 'Récentes'], ['price_asc', 'Prix croissant'], ['price_desc', 'Prix décroissant'], ['ending_soon', 'Fin proche']] as const
// États vides (P21).
const EMPTY: Record<MineTab, string> = {
  selling: 'Tu n\'as aucune vente en cours.',
  bidding: 'Tu n\'as encore misé sur aucune enchère.',
  won: 'Tu n\'as encore remporté aucune enchère.',
  history: 'Aucune vente terminée.',
}

const control = 'min-h-11 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'
const readMine = (page: number) => api<MineLists>(`/api/marketplace?mine=1&page=${page}`)
// Une enchère passée d'une page à l'autre entre deux lectures n'est gardée qu'une fois (P17 : ids et clés React uniques, M3-2).
const unique = (items: Auction[]) => [...new Map(items.map((a) => [a.id, a])).values()]

// /marketplace (M3-24) : en-tête, onglets, et la liste de l'onglet visible, seule montée (M3-2).
// shortcut: onglet et filtres en mémoire et non dans l'adresse (comme /global-collection) ; les passer en ?tab/q/sort/rarity si on le demande.
export function MarketClient() {
  const id = useId()
  const [tab, setTab] = useState<Tab>('browse')
  // Compteurs des onglets : page 1 de ?mine=1 (les listes du joueur la relisent aussi).
  const [mine, setMine] = useState<MineLists | null>(null)
  const [q, setQ] = useState('')
  const [text, setText] = useState('')
  const [tooShort, setTooShort] = useState(false)
  const [sort, setSort] = useState('recent')
  const [rarity, setRarity] = useState<RarityCode[]>([])

  // Échec : les compteurs restent ceux d'avant, relus au prochain passage.
  const readCounts = () => readMine(1).then(setMine, () => {})
  // À chaque affichage (Activity compris), comme collection-client.tsx.
  const onShow = useEffectEvent(readCounts)
  useEffect(() => void onShow(), [])
  usePoll(readCounts, POLL_MS, tab === 'browse')

  const sp = new URLSearchParams({ sort })
  if (q) sp.set('q', q)
  for (const r of rarity) sp.append('rarity', r)
  const query = sp.toString()
  const loadBrowse = async (page: number): Promise<Page> => {
    const r = await api<{ auctions: Auction[]; hasMore: boolean }>(`/api/marketplace?${query}&page=${page}`)
    return { items: r.auctions, more: r.hasMore }
  }
  // Une page de ?mine=1 porte toutes les listes : celle de l'onglet, et les compteurs à la page 1 (« page × 50 < count », P17).
  const loadMine = (t: MineTab) => async (page: number): Promise<Page> => {
    const r = await readMine(page)
    if (page === 1) setMine(r)
    return { items: r[t], more: page * PAGE < r.counts[t] }
  }

  const count = (n: number | undefined) => (n === undefined ? '' : ` (${formatInt(n)})`)
  const LABELS: Record<Tab, string> = {
    browse: 'Parcourir',
    selling: `Mes ventes${mine ? ` (${formatInt(mine.sellingCount)}/${formatInt(mine.maxConcurrentAuctions)})` : ''}`,
    bidding: `Mes enchères${count(mine?.counts.bidding)}`,
    won: 'Gagnées',
    history: `Historique${count(mine?.counts.history)}`,
  }

  // Clavier de CardModal.tsx : flèches (en boucle), Début et Fin ; l'onglet suit le focus.
  const tabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab)
    const j = ({ ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[e.key]
    if (j === undefined) return
    e.preventDefault()
    const next = TABS[(j + TABS.length) % TABS.length]
    setTab(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const v = text.trim()
    if (!v) return
    // Seuil du serveur (wm.market_list) en caractères : refusé sur place, sans requête (global-client.tsx).
    if ([...v].length < 2) return setTooShort(true)
    setQ(v)
  }

  function onText(v: string) {
    setText(v)
    setTooShort(false)
    // Champ vidé (croix du champ de recherche comprise) : retour à toutes les enchères.
    if (!v.trim() && q) setQ('')
  }

  return (
    <>
      <div className="space-y-1">
        <PageHeader title={entry.title} icon={entry.icon} />
        <p className="text-sm text-[var(--color-foreground)]/70">Enchérissez sur des cartes ou vendez les vôtres contre des wikis.</p>
      </div>

      <div role="tablist" aria-label="Vues du marché" className="flex flex-wrap gap-x-1 border-b border-[var(--color-border)]">
        {TABS.map((t) => (
          <button
            key={t}
            id={`${id}-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={tabKey}
            className={`inline-flex min-h-11 items-center whitespace-nowrap px-4 text-sm font-semibold transition-colors ${tab === t ? 'border-b-2 border-amber-500 text-amber-600' : 'border-b-2 border-transparent text-[var(--color-foreground)]/70 hover:text-[var(--color-foreground)]'}`}
          >
            {LABELS[t]}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="space-y-6">
        {tab === 'browse' ? (
          <>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <form role="search" onSubmit={submit} className="flex w-full min-w-0 sm:w-auto sm:flex-1 sm:basis-80">
                  {/* Envoi sur Entrée (un seul champ : soumission implicite). */}
                  <input
                    type="search"
                    aria-label="Rechercher une enchère"
                    placeholder="Rechercher une enchère…"
                    value={text}
                    onChange={(e) => onText(e.target.value)}
                    aria-invalid={tooShort || undefined}
                    aria-describedby={tooShort ? `${id}-search-error` : undefined}
                    className={`${control} min-w-0 flex-1 py-2.5 placeholder:text-[var(--color-foreground)]/60`}
                  />
                </form>
                <select aria-label="Trier" value={sort} onChange={(e) => setSort(e.target.value)} className={control}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {tooShort && <p id={`${id}-search-error`} role="alert" className="text-sm font-medium text-red-400">La recherche demande au moins 2 caractères</p>}
              <RarityChips value={rarity} onChange={setRarity} />
            </div>
            <AuctionList
              key={query}
              load={loadBrowse}
              empty={q || rarity.length ? 'Aucune enchère ne correspond à ta recherche.' : 'Aucune enchère en cours.'}
            />
          </>
        ) : (
          <AuctionList key={tab} load={loadMine(tab)} empty={EMPTY[tab]} />
        )}
      </div>
    </>
  )
}

// Liste paginée d'un onglet : lue à chaque affichage, relue toutes les 15 s (pages déjà chargées, de la première à la dernière),
// « Charger la suite » ajoute la page suivante au DOM (P17). Remontée par sa clé à chaque changement d'onglet ou de requête.
function AuctionList({ load, empty }: { load: (page: number) => Promise<Page>; empty: string }) {
  const [data, setData] = useState<{ pages: number; items: Auction[]; more: boolean } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const grid = useRef<HTMLDivElement>(null)
  // Rang de la tuile à focaliser si le bouton pressé disparaît (dernière page, ou « Réessayer ») : jamais le focus sur body.
  const refocus = useRef<number | null>(null)

  const reread = () => {
    const n = data?.pages ?? 1
    return Promise.all(Array.from({ length: n }, (_, i) => load(i + 1))).then(
      (all) => {
        // « Charger la suite » a ajouté une page pendant la relecture : sa liste est plus complète, on la garde.
        setData((d) => (d && d.pages !== n ? d : { pages: n, items: unique(all.flatMap((p) => p.items)), more: all[n - 1].more }))
        setFailed(null)
      },
      // Affiché seulement sans liste ; une relecture en échec garde la liste d'avant.
      (e) => setFailed(userMessage(e, 'Les enchères n\'ont pas pu être chargées.')),
    )
  }
  const onShow = useEffectEvent(reread)
  useEffect(() => void onShow(), [])
  usePoll(reread, POLL_MS)

  async function more() {
    if (!data || busy) return
    const n = data.pages
    const first = data.items.length
    setBusy(true)
    try {
      const p = await load(n + 1)
      // Posé seulement maintenant : une relecture rendue entre-temps l'aurait consommé, bouton encore là.
      refocus.current = first
      setData((d) => (d && d.pages === n ? { pages: n + 1, items: unique([...d.items, ...p.items]), more: p.more } : d))
    } catch (e) {
      toast(userMessage(e, 'La suite n\'a pas pu être chargée.'))
    }
    setBusy(false)
  }

  useEffect(() => {
    const i = refocus.current
    if (i === null || !data) return
    refocus.current = null
    if (document.activeElement === document.body) grid.current?.querySelectorAll('a')[Math.min(i, data.items.length - 1)]?.focus()
  }, [data])

  if (!data) {
    return failed ? (
      <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <p role="alert" className="text-sm">{failed}</p>
        <button
          type="button"
          onClick={() => {
            refocus.current = 0
            void reread()
          }}
          className={`${ghost} justify-center`}
        >
          Réessayer
        </button>
      </div>
    ) : (
      <Loading label="Chargement des enchères" />
    )
  }
  if (!data.items.length) return <p className="card-frame mx-auto max-w-md p-8 text-center font-semibold">{empty}</p>
  return (
    <div className="space-y-6">
      <div ref={grid} className="flex flex-wrap justify-center gap-3">
        {data.items.map((a) => <AuctionTile key={a.id} auction={a} />)}
      </div>
      {data.more && (
        <div className="flex justify-center">
          {/* aria-disabled et la garde de more() pendant la requête, jamais disabled (le focus tomberait sur body, D§7.0). */}
          <button type="button" aria-disabled={busy || undefined} onClick={() => void more()} className={`${ghost} justify-center aria-disabled:cursor-progress`}>
            Charger la suite
          </button>
        </div>
      )}
    </div>
  )
}
