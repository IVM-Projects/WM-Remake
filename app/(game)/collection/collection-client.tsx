'use client'

import { BookOpen } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Card } from '@/components/card/Card'
import { CardModal, faceOf, type CardChange, type OwnedItem } from '@/components/card/CardModal'
import { CollectionToolbar, type TagCount } from '@/components/collection/CollectionToolbar'
import { SelectionBar } from '@/components/collection/SelectionBar'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { Pagination } from '@/components/ui/Pagination'
import { WCoin } from '@/components/ui/WCoin'
import { api } from '@/lib/api'
import { formatInt } from '@/lib/format'
import type { RarityCode } from '@/lib/rarity'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/collection')
const LIMIT = 50
const SEARCH_DELAY_MS = 300

type CollectionPage = { collection: OwnedItem[]; total: number }

// L'état de la page vit dans l'adresse (?page, q, sort, rarity, tag_id) : Retour et rechargement le gardent.
// pushState s'intègre au routeur (useSearchParams suit). Changer un filtre ramène à la première page.
function go(patch: Record<string, string | string[] | null>, replace = false) {
  const next = new URLSearchParams(window.location.search)
  if (!('page' in patch)) next.delete('page')
  for (const [k, v] of Object.entries(patch)) {
    next.delete(k)
    for (const x of v === null ? [] : [v].flat()) next.append(k, x)
  }
  const url = next.size ? `?${next}` : window.location.pathname
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}

// Chargement du R§6.3 ; sert aussi de repli à la page tant que l'adresse n'est pas lue.
export function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center py-16" role="status">
      <div className="w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
      <span className="sr-only">Chargement de la collection</span>
    </div>
  )
}

export function CollectionClient() {
  const params = useSearchParams()
  // Les paramètres de l'adresse sont ceux de /api/my-collection : la requête les reprend tels quels (le serveur les valide).
  const query = params.toString()
  const page = Math.max(0, Math.trunc(Number(params.get('page'))) || 0)
  const q = params.get('q') ?? ''
  const sort = params.get('sort') ?? 'rarity'
  const rarity = params.getAll('rarity') as RarityCode[]
  const tagId = params.get('tag_id') ?? ''

  const [reload, setReload] = useState(0)
  const key = `${query}#${reload}`
  const [data, setData] = useState<(CollectionPage & { key: string }) | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [tags, setTags] = useState<TagCount[]>([])
  const [text, setText] = useState(q)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [open, setOpen] = useState<OwnedItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Génération du solde : une réponse de défausse rend périmée une lecture partie avant elle.
  const balanceGen = useRef(0)
  const starring = useRef(new Set<string>())
  // La modale a changé ce que montre la grille (défausse, étiquettes) : relecture à sa fermeture.
  const dirty = useRef(false)
  // Rang de la tuile de la modale fermée : si la relecture la retire, le focus va à la suivante, jamais sur body.
  const refocus = useRef<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const empty = useRef<HTMLDivElement>(null)

  const items = data?.collection ?? []
  const loading = data?.key !== key && failedKey !== key
  const totalPages = Math.ceil((data?.total ?? 0) / LIMIT)

  useEffect(() => {
    let live = true
    api<CollectionPage>(`/api/my-collection?${query}`)
      .then((r) => { if (live) setData({ ...r, key }) })
      .catch(() => { if (live) setFailedKey(key) })
    return () => { live = false }
  }, [key, query])

  const readBalance = () => {
    const g = ++balanceGen.current
    api<{ balance: number }>('/api/wikibidous').then((r) => { if (g === balanceGen.current) setBalance(r.balance) }, () => {})
  }
  const freshBalance = (b: number) => {
    balanceGen.current++
    setBalance(b)
  }
  // Étiquettes du joueur et nombre de copies de chacune (PostgREST, comptage embarqué), pour « Toutes les étiquettes ».
  const loadTags = () => {
    void createBrowserSupabase().from('tags').select('id,name,color,user_card_tags(count)').order('name').then(({ data: rows }) => {
      if (rows) setTags((rows as (Omit<TagCount, 'count'> & { user_card_tags: { count: number }[] })[])
        .map(({ user_card_tags, ...t }) => ({ ...t, count: user_card_tags[0]?.count ?? 0 })))
    })
  }
  const refresh = () => {
    setReload((r) => r + 1)
    loadTags()
  }

  // À chaque affichage (Activity compris) : solde et étiquettes relus. Retour/Avancer : le champ reprend la recherche de l'adresse.
  const onShow = useEffectEvent(() => {
    readBalance()
    loadTags()
  })
  useEffect(() => {
    onShow()
    const onPop = () => {
      clearTimeout(timer.current)
      setText(new URLSearchParams(window.location.search).get('q') ?? '')
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      clearTimeout(timer.current)
    }
  }, [])

  useEffect(() => {
    if (!data || data.key !== key) return
    // Page vidée par une défausse ou un filtre : la dernière page qui existe.
    const last = Math.max(0, Math.ceil(data.total / LIMIT) - 1)
    if (!data.collection.length && page > last) return go({ page: last ? String(last) : null }, true)
    const i = refocus.current
    refocus.current = null
    if (i === null || (document.activeElement && document.activeElement !== document.body)) return
    const tiles = grid.current?.querySelectorAll<HTMLElement>('h3 > button')
    ;(tiles?.length ? tiles[Math.min(i, tiles.length - 1)] : empty.current)?.focus()
  }, [data, key, page])

  // Recherche serveur après un temps de frappe ; replaceState : une entrée d'historique par recherche, pas par touche.
  function onText(value: string) {
    setText(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => go({ q: value.trim() || null }, true), SEARCH_DELAY_MS)
  }

  const patchItem = (id: string, change: Partial<OwnedItem>) =>
    setData((d) => d && { ...d, collection: d.collection.map((x) => (x.id === id ? { ...x, ...change } : x)) })

  // PATCH user_cards {starred} en direct (RLS, D§7.3), optimiste ; un PATCH à la fois par copie.
  async function toggleStar(item: OwnedItem) {
    if (starring.current.has(item.id)) return
    starring.current.add(item.id)
    const next = !item.starred
    patchItem(item.id, { starred: next })
    const { error } = await createBrowserSupabase().from('user_cards').update({ starred: next }).eq('id', item.id)
    starring.current.delete(item.id)
    if (error) {
      patchItem(item.id, { starred: !next })
      setNotice('Le favori n\'a pas pu être enregistré.')
    } else setNotice(null)
  }

  function onChanged(id: string, change: CardChange) {
    if (change.starred !== undefined) patchItem(id, { starred: change.starred })
    if (change.tags) {
      patchItem(id, { tags: change.tags })
      dirty.current = true
    }
  }

  function closeModal() {
    if (dirty.current) {
      dirty.current = false
      refocus.current = items.findIndex((x) => x.id === open?.id)
      refresh()
    }
    setOpen(null)
  }

  function setSelectingMode(on: boolean) {
    setSelecting(on)
    setSelected([])
  }

  function clearFilters() {
    clearTimeout(timer.current)
    setText('')
    go({ q: null, rarity: null, tag_id: null })
  }

  const filtered = !!(q || rarity.length || tagId)

  return (
    <>
      <PageHeader title={entry.title} icon={entry.icon}>
        {balance !== null && (
          <p title="Solde de wikibidous" className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-semibold tabular-nums">
            <WCoin className="size-5 text-amber-300" />
            {formatInt(balance)}
            <span className="sr-only"> wikibidous</span>
          </p>
        )}
      </PageHeader>

      <CollectionToolbar
        text={text}
        onText={onText}
        tagId={tagId}
        onTag={(v) => go({ tag_id: v || null })}
        tags={tags}
        sort={sort}
        onSort={(v) => go({ sort: v === 'rarity' ? null : v })}
        rarity={rarity}
        onRarity={(v) => go({ rarity: v })}
        selecting={selecting}
        onSelecting={setSelectingMode}
      />

      {selecting && (
        <SelectionBar
          ids={selected}
          onSelectAll={() => setSelected((s) => [...new Set([...s, ...items.map((x) => x.id)])])}
          tags={tags}
          onTagged={refresh}
          onDiscarded={() => {
            setSelected([])
            refresh()
            readBalance()
          }}
        />
      )}

      {notice && <p role="alert" className="text-sm font-medium text-red-400">{notice}</p>}

      {failedKey === key ? (
        <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
          <p role="alert" className="text-sm">Ta collection n&apos;a pas pu être chargée.</p>
          <button
            type="button"
            // Le bouton disparaît avec l'erreur : le focus va ensuite à la première tuile (ou à l'état vide).
            onClick={() => {
              refocus.current = 0
              setReload((r) => r + 1)
            }}
            className="min-h-11 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]"
          >
            Réessayer
          </button>
        </div>
      ) : !data ? (
        <Loading />
      ) : items.length === 0 ? (
        <div ref={empty} tabIndex={-1} className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-8 text-center outline-none">
          {filtered ? (
            <>
              <p className="font-semibold">Aucune carte ne correspond à ces filtres.</p>
              <button
                type="button"
                onClick={clearFilters}
                className="min-h-11 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]"
              >
                Effacer les filtres
              </button>
            </>
          ) : (
            <>
              <BookOpen className="size-8 text-[var(--color-accent)]" aria-hidden="true" />
              <p className="text-lg font-semibold">Ta collection est vide</p>
              <p className="text-sm text-[var(--color-foreground)]/70">Chaque paquet ouvert y range ses cartes.</p>
              <Link
                href="/pulls"
                className="inline-flex min-h-11 items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)]"
              >
                Ouvrir des paquets
              </Link>
            </>
          )}
        </div>
      ) : (
        <>
          <div ref={grid} aria-busy={loading} className="flex flex-wrap justify-center gap-3">
            {items.map((item) => {
              const face = faceOf(item)
              const checked = selected.includes(item.id)
              return (
                <div key={item.id} className="relative isolate group">
                  <Card
                    card={face}
                    size="grid"
                    owned
                    starred={item.starred}
                    onToggleStar={() => void toggleStar(item)}
                    count={item.count}
                    isShiny={item.is_shiny}
                    onClick={selecting ? undefined : () => setOpen(item)}
                  />
                  {selecting && (
                    // Toute la tuile coche la case ; l'anneau émeraude marque les cartes retenues.
                    <label className={`absolute inset-0 z-50 cursor-pointer rounded-2xl ${checked ? 'ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-background)]' : ''}`}>
                      <span className="absolute top-2 left-1/2 inline-flex -translate-x-1/2 rounded-lg bg-black/65 p-1.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelected((s) => (s.includes(item.id) ? s.filter((x) => x !== item.id) : [...s, item.id]))}
                          aria-label={face.wikipedia_title}
                          className="size-5 cursor-pointer accent-[var(--color-accent)]"
                        />
                      </span>
                    </label>
                  )}
                </div>
              )
            })}
          </div>
          <Pagination
            page={page}
            totalPages={totalPages}
            onPage={(p) => {
              go({ page: p ? String(p) : null })
              document.querySelector('main')?.scrollTo({ top: 0 })
            }}
          />
        </>
      )}

      {open && (
        <CardModal
          item={open}
          onClose={closeModal}
          onDiscarded={(b) => {
            freshBalance(b)
            dirty.current = true
          }}
          onChanged={(change) => onChanged(open.id, change)}
        />
      )}
    </>
  )
}
