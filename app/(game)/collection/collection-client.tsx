'use client'

import { BookOpen } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useEffectEvent, useRef, useState } from 'react'
import { Card } from '@/components/card/Card'
import { CardModal, faceOf, type CardChange, type OwnedItem } from '@/components/card/CardModal'
import { CollectionToolbar, type TagCount } from '@/components/collection/CollectionToolbar'
import { SelectionBar } from '@/components/collection/SelectionBar'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { Loading } from '@/components/ui/Loading'
import { Pagination } from '@/components/ui/Pagination'
import { WCoin } from '@/components/ui/WCoin'
import { api } from '@/lib/api'
import { formatInt } from '@/lib/format'
import type { RarityCode } from '@/lib/rarity'
import { CollectionQuery, Rarity } from '@/lib/schemas'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/collection')
const LIMIT = 50
const SEARCH_DELAY_MS = 300

type CollectionPage = { collection: OwnedItem[]; total: number }

// Une valeur que /api/my-collection refuserait (400) est ignorée : une adresse périmée affiche quand même la grille.
const valid = (key: 'page' | 'sort' | 'tag_id', v: string | null): v is string => v !== null && CollectionQuery.shape[key].safeParse(v).success

// L'état de la page vit dans l'adresse (?page, q, sort, rarity, tag_id) : Retour et rechargement le gardent.
// pushState s'intègre au routeur (useSearchParams suit). Changer un filtre ramène à la première page.
function go(patch: Record<string, string | string[] | null>, replace = false) {
  const next = new URLSearchParams(window.location.search)
  if (!('page' in patch)) next.delete('page')
  for (const [k, v] of Object.entries(patch)) {
    next.delete(k)
    for (const x of v === null ? [] : [v].flat()) next.append(k, x)
  }
  // Pas de URLSearchParams.size : absent de Chrome/Firefox 111–112 et Safari 16.4–16.7, que Next 16 prend en charge.
  const s = next.toString()
  const url = s ? `?${s}` : window.location.pathname
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}

type Balance = { readBalance: () => void; freshBalance: (b: number) => void }

// En-tête et solde hors du Suspense : rendus une fois dans la coquille statique, ils ne sont pas remplacés (ni refondus) à l'hydratation.
export function CollectionClient() {
  const [balance, setBalance] = useState<number | 'error' | null>(null)
  // Génération du solde : une réponse de défausse rend périmée une lecture partie avant elle.
  const balanceGen = useRef(0)
  const readBalance = () => {
    const g = ++balanceGen.current
    api<{ balance: number }>('/api/wikibidous').then(
      (r) => { if (g === balanceGen.current) setBalance(r.balance) },
      () => { if (g === balanceGen.current) setBalance('error') },
    )
  }
  const freshBalance = (b: number) => {
    balanceGen.current++
    setBalance(b)
  }
  // À chaque affichage (Activity compris).
  const onShow = useEffectEvent(readBalance)
  useEffect(() => onShow(), [])

  return (
    <>
      <PageHeader title={entry.title} icon={entry.icon}>
        {balance !== null && (
          <p title="Solde de wikibidous" className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-semibold tabular-nums">
            <WCoin className="size-5 text-amber-300" />
            {balance === 'error' ? (
              // Relu à la prochaine défausse.
              <>
                <span aria-hidden="true">—</span>
                <span className="sr-only">Solde indisponible</span>
              </>
            ) : (
              <>
                {formatInt(balance)}
                <span className="sr-only"> wikibidous</span>
              </>
            )}
          </p>
        )}
      </PageHeader>
      {/* useSearchParams : seule la grille attend le client. */}
      <Suspense fallback={<Loading label="Chargement de la collection" />}>
        <CollectionBody readBalance={readBalance} freshBalance={freshBalance} />
      </Suspense>
    </>
  )
}

function CollectionBody({ readBalance, freshBalance }: Balance) {
  const params = useSearchParams()
  const rawPage = params.get('page')
  const rawSort = params.get('sort')
  const rawTag = params.get('tag_id')
  const page = valid('page', rawPage) ? Number(rawPage) : 0
  const q = params.get('q') ?? ''
  const sort = valid('sort', rawSort) ? rawSort : 'rarity'
  const rarity = params.getAll('rarity').filter((r) => Rarity.safeParse(r).success) as RarityCode[]
  const tagId = valid('tag_id', rawTag) ? rawTag : ''
  // Seules ces cinq clés et la limite du client partent à l'API : ni clé inconnue, ni limit venue de l'adresse.
  const sp = new URLSearchParams({ limit: String(LIMIT), page: String(page), sort })
  if (q) sp.set('q', q)
  for (const r of rarity) sp.append('rarity', r)
  if (tagId) sp.set('tag_id', tagId)
  const query = sp.toString()

  const [reload, setReload] = useState(0)
  const key = `${query}#${reload}`
  const [data, setData] = useState<(CollectionPage & { key: string }) | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [tags, setTags] = useState<TagCount[]>([])
  const [tagsFailed, setTagsFailed] = useState(false)
  const [text, setText] = useState(q)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  // Filtres, tri ou recherche changés : la sélection se vide. Elle ne survit qu'aux changements de page (lots de plus de 50).
  const filterKey = JSON.stringify([q, sort, rarity, tagId])
  const [selectedFor, setSelectedFor] = useState(filterKey)
  if (selectedFor !== filterKey) {
    setSelectedFor(filterKey)
    setSelected([])
  }
  const [open, setOpen] = useState<OwnedItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const tagsGen = useRef(0)
  const starring = useRef(new Set<string>())
  // La modale a changé ce que montre la grille (défausse, étiquettes) : relecture à sa fermeture.
  const dirty = useRef(false)
  // Rang de la tuile de la modale fermée : si la relecture la retire, le focus va à la suivante, jamais sur body.
  const refocus = useRef<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const empty = useRef<HTMLDivElement>(null)
  const retry = useRef<HTMLButtonElement>(null)

  const items = data?.collection ?? []
  // stale : la grille affichée n'est pas celle de l'adresse (relecture en cours ou en échec) ; aucune sélection ne s'y fait.
  const stale = data?.key !== key
  const loading = stale && failedKey !== key
  const totalPages = Math.ceil((data?.total ?? 0) / LIMIT)

  useEffect(() => {
    let live = true
    api<CollectionPage>(`/api/my-collection?${query}`)
      .then((r) => { if (live) setData({ ...r, key }) })
      .catch(() => { if (live) setFailedKey(key) })
    // Nouvelle requête : l'échec d'avant s'efface, une adresse qui avait échoué ne remontre pas l'erreur pendant sa relecture.
    return () => {
      live = false
      setFailedKey(null)
    }
  }, [key, query])

  // Étiquettes du joueur et nombre de copies de chacune (PostgREST, comptage embarqué), pour « Toutes les étiquettes ».
  // Génération : une réponse tardive n'écrase pas des nombres plus frais.
  const loadTags = () => {
    const g = ++tagsGen.current
    void createBrowserSupabase().from('tags').select('id,name,color,user_card_tags(count)').order('name').then(({ data: rows }) => {
      if (g !== tagsGen.current) return
      setTagsFailed(!rows)
      if (rows) setTags((rows as (Omit<TagCount, 'count'> & { user_card_tags: { count: number }[] })[])
        .map(({ user_card_tags, ...t }) => ({ ...t, count: user_card_tags[0]?.count ?? 0 })))
    })
  }
  const refresh = () => {
    setReload((r) => r + 1)
    loadTags()
  }

  // À chaque affichage (Activity compris) : étiquettes relues (le solde, par CollectionClient). Retour/Avancer : le champ reprend la recherche de l'adresse.
  const onShow = useEffectEvent(loadTags)
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
    const failed = failedKey === key
    if (!failed) {
      if (!data || data.key !== key) return
      // Page vidée par une défausse ou un filtre : la dernière page qui existe.
      const last = Math.max(0, Math.ceil(data.total / LIMIT) - 1)
      if (!data.collection.length && page > last) return go({ page: last ? String(last) : null }, true)
    }
    const i = refocus.current
    refocus.current = null
    if (i === null || (document.activeElement && document.activeElement !== document.body)) return
    const tiles = grid.current?.querySelectorAll<HTMLElement>('h3 > button')
    // Nouvel échec : le « Réessayer » du nouveau panneau d'erreur.
    ;(failed ? retry.current : tiles?.length ? tiles[Math.min(i, tiles.length - 1)] : empty.current)?.focus()
  }, [data, failedKey, key, page, open]) // open : fermer la modale sur une grille déjà en échec ou relue rend aussi le focus.

  // Recherche serveur après un temps de frappe ; replaceState : une entrée d'historique par recherche, pas par touche.
  function onText(value: string) {
    setText(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => go({ q: value.trim() || null }, true), SEARCH_DELAY_MS)
  }

  const patchItem = (id: string, change: Partial<OwnedItem>) =>
    setData((d) => d && { ...d, collection: d.collection.map((x) => (x.id === id ? { ...x, ...change } : x)) })

  // PATCH user_cards {starred} en direct (RLS, D§7.3), optimiste ; un PATCH à la fois par copie.
  // Grille périmée (relecture en cours) : sa réponse, lue avant ce PATCH, écraserait l'étoile ; inactive le temps de la relecture.
  async function toggleStar(item: OwnedItem) {
    if (stale || starring.current.has(item.id)) return
    starring.current.add(item.id)
    const next = !item.starred
    patchItem(item.id, { starred: next })
    // select('id') : une ligne que la RLS écarte n'est pas modifiée et ne revient pas, ce n'est pas un succès.
    const { data: rows, error } = await createBrowserSupabase().from('user_cards').update({ starred: next }).eq('id', item.id).select('id')
    starring.current.delete(item.id)
    if (error || !rows?.length) {
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
    // Grille périmée ou en échec : la place de la copie dans la grille de l'adresse est inconnue.
    const i = stale ? -1 : items.findIndex((x) => x.id === open?.id)
    // Toujours : l'effet ne bouge le focus que s'il est tombé sur body (tuile d'origine démontée, grille relue ou en échec) ;
    // il va alors à la tuile de même rang (le nouveau nœud de la copie si elle est revenue), sinon à la première.
    refocus.current = Math.max(0, i)
    if (dirty.current) {
      dirty.current = false
      refresh()
    }
    setOpen(null)
  }

  function setSelectingMode(on: boolean) {
    setSelecting(on)
    setSelected([])
  }

  function clearFilters() {
    // Le bouton disparaît avec son panneau : le focus va ensuite à la première tuile.
    refocus.current = 0
    clearTimeout(timer.current)
    setText('')
    go({ q: null, rarity: null, tag_id: null })
  }

  const filtered = !!(q || rarity.length || tagId)

  return (
    <>
      <CollectionToolbar
        text={text}
        onText={onText}
        tagId={tagId}
        onTag={(v) => go({ tag_id: v || null })}
        tags={tags}
        tagsFailed={tagsFailed}
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
          loading={stale}
          onSelectAll={() => setSelected((s) => [...new Set([...s, ...items.map((x) => x.id)])])}
          tags={tags}
          tagsFailed={tagsFailed}
          onTagged={refresh}
          onDiscarded={(keep) => {
            setSelected(keep)
            refresh()
            readBalance()
          }}
        />
      )}

      {notice && <p role="alert" className="text-sm font-medium text-red-400">{notice}</p>}

      {failedKey === key ? (
        <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
          <p role="alert" className="text-sm">Ta collection n&apos;a pas pu être chargée.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              ref={retry}
              type="button"
              // Le bouton disparaît avec l'erreur : le focus va ensuite à la première tuile (ou à l'état vide, ou au nouveau « Réessayer »).
              onClick={() => {
                refocus.current = 0
                setReload((r) => r + 1)
              }}
              className="min-h-11 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]"
            >
              Réessayer
            </button>
            {/* Une adresse gardée en favori ne doit jamais bloquer sur l'erreur. */}
            {filtered && (
              <button
                type="button"
                onClick={clearFilters}
                className="min-h-11 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]"
              >
                Effacer les filtres
              </button>
            )}
          </div>
        </div>
      ) : !data ? (
        <Loading label="Chargement de la collection" />
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
                    starOff={stale}
                    count={item.count}
                    isShiny={item.is_shiny}
                    // Un objet par ouverture : une défausse tardive ne referme que la modale qui l'a lancée (voir onDiscarded).
                    onClick={selecting ? undefined : () => setOpen({ ...item })}
                  />
                  {selecting && (
                    // Toute la tuile coche la case ; l'anneau émeraude marque les cartes retenues.
                    <label className={`absolute inset-0 z-50 cursor-pointer rounded-2xl ${checked ? 'ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-background)]' : ''}`}>
                      <span className="absolute top-2 left-1/2 inline-flex -translate-x-1/2 rounded-lg bg-black/65 p-1.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          // Grille périmée pendant une relecture : ses copies ne se sélectionnent pas.
                          aria-disabled={stale}
                          onChange={() => { if (!stale) setSelected((s) => (s.includes(item.id) ? s.filter((x) => x !== item.id) : [...s, item.id])) }}
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
          onDiscarded={(b, closed) => {
            if (!closed) {
              if (b === null) readBalance()
              else freshBalance(b)
              dirty.current = true
              return
            }
            // Réponse tardive (modale fermée) : le solde est relu, une défausse plus récente a pu en poser un plus frais.
            readBalance()
            // Défausse finie après la fermeture de sa modale : grille relue tout de suite ; si sa tuile disparaît sous le focus, la suivante le prend.
            refocus.current = Math.max(0, items.findIndex((x) => x.id === open.id))
            refresh()
            // Page cachée par Activity, sa modale encore ouverte : fermée, elle ne reviendrait pas sur la copie d'avant la défausse.
            // Comparée à son ouverture (un objet par clic), jamais une modale ouverte depuis, même sur la même copie.
            setOpen((o) => (o === open ? null : o))
          }}
          onChanged={(change) => onChanged(open.id, change)}
        />
      )}
    </>
  )
}
