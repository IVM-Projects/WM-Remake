'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { Card } from '@/components/card/Card'
import { CardModal, type CatalogCard } from '@/components/card/CardModal'
import { ReportModal } from '@/components/profile/ReportModal'
import { copyFace, type CopyFace, type ProfileView as View, type ShowcaseItem } from '@/components/profile/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { ghost, link, primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Pagination } from '@/components/ui/Pagination'
import { tabKey } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import { api, ApiError, apiOnce, unsure, userMessage } from '@/lib/api'
import { formatInt, formatMonthYear } from '@/lib/format'
import { RARITY, type RarityCode } from '@/lib/rarity'

const entry = navEntry('/profile')
const TABS = ['showcase', 'collection'] as const
type Tab = (typeof TABS)[number]
const LABELS: Record<Tab, string> = { showcase: 'Vitrine', collection: 'Collection' }
const LIMIT = 50
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'
const grid = 'flex flex-wrap justify-center gap-3 sm:gap-[22px] md:gap-[26px]'
const field = 'min-h-11 w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm'

type CollectionPage = { collection: CopyFace[]; total: number; rarityCounts?: Record<RarityCode, number> }
// Vitrine et raretés d'une vue permise : lues, refusées (403 : le profil est passé privé depuis sa lecture) ou en échec.
type Extra = { showcase: ShowcaseItem[]; counts: Record<RarityCode, number> } | 'private' | 'failed'

// Lecture qui suit le profil : 403 → 'private' ; autre échec → null, comme un 2xx au corps illisible (api() rend null).
const follow = <T,>(path: string) => api<T | null>(path).catch((e) => (e instanceof ApiError && e.status === 403 ? 'private' as const : null))

// /profile/[username] (M4b-24) : identité, vitrine et collection quand la vue est permise, amitié, message, échange, signalement.
// Aucun polling : relu à chaque affichage (Activity compris), après chaque action et sur « Réessayer ».
export function ProfileView() {
  // Cachée par Activity, la page se rend avec les paramètres de la page visible : son pseudo est figé au montage. Il arrive encodé
  // (get-dynamic-param.js) et va tel quel dans les URL de l'API ; l'écran prend profile.username de la réponse.
  const { username: u } = useParams<{ username: string }>()
  const [username] = useState(u)
  const id = useId()
  const [view, setView] = useState<View | null>(null)
  const [extra, setExtra] = useState<Extra | null>(null)
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<Tab>('showcase')
  const [open, setOpen] = useState<CatalogCard | null>(null)
  const [reporting, setReporting] = useState(false)
  // Une action à la fois, jusqu'à sa relecture : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  // Génération : une lecture tardive n'écrase pas une plus récente (réaffichage pendant la relecture d'une action).
  const gen = useRef(0)
  const title = useRef<HTMLHeadingElement>(null)
  const lost = useRef<HTMLHeadingElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  // Cible du focus après la lecture que l'on attend, s'il est tombé sur body : le contrôle d'amitié (action) ou le h1 (« Réessayer »).
  const refocus = useRef<'act' | 'retry' | null>(null)

  const readExtra = (g: number) => Promise.all([
    follow<{ showcase: ShowcaseItem[] }>(`/api/profile/${username}/showcase`),
    // Seulement pour rarityCounts : l'onglet « Collection » lit ses propres pages.
    follow<CollectionPage>(`/api/profile/${username}/collection?page=0&stats=1`),
  ]).then(([s, c]) => {
    if (g !== gen.current) return
    // Emplacements déjà triés par position (B2, wm.showcase_json).
    setExtra(s === 'private' || c === 'private' ? 'private'
      : Array.isArray(s?.showcase) && c?.rarityCounts ? { showcase: s.showcase, counts: c.rarityCounts } : 'failed')
  })

  const read = () => {
    const g = ++gen.current
    return api<View | null>(`/api/profile/${username}`).then((r) => {
      if (g !== gen.current) return
      // 2xx au corps illisible ou sans profile : une lecture en échec ; le profil affiché reste.
      if (!r?.profile) return setFailed(true)
      // État du serveur relu : une relance est une nouvelle intention, refusée par l'amitié relue si elle a déjà eu lieu.
      keys.current.clear()
      setView(r)
      setMissing(false)
      setFailed(false)
      if (r.isOwn || r.isFriend || r.profile.is_public) return readExtra(g)
      setExtra(null)
    }, (e) => {
      if (g !== gen.current) return
      // Inconnu (404) ou pseudo invalide (400) : « Joueur introuvable ». Autre échec : le profil affiché reste.
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setMissing(true)
      else setFailed(true)
    })
  }
  const onShow = useEffectEvent(() => void read())
  useEffect(() => onShow(), [])

  // Le contrôle focalisé a disparu (action faite, « Réessayer » sous le clic) : le focus tombé sur body va au contrôle d'amitié revenu, au
  // h1, à « Joueur introuvable » ou au « Réessayer » revenu. Rien si le joueur l'a mis ailleurs.
  useEffect(() => {
    const want = refocus.current
    if (!want || (!view && !failed && !missing)) return
    refocus.current = null
    if (document.activeElement !== document.body) return
    if (missing) lost.current?.focus()
    else if (!view) retryButton.current?.focus()
    else if (want === 'act') actions.current?.querySelector<HTMLElement>('a, button, [tabindex]')?.focus()
    else title.current?.focus()
  }, [view, failed, missing])

  // Relue même après un refus : l'amitié a pu changer ailleurs. Issue inconnue : la clé reste (apiOnce), jusqu'à la relecture réussie.
  async function act(intent: string, path: string, init: RequestInit, done: string) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    try {
      toast((await apiOnce<object | null>(keys.current, intent, path, init)) ? done : UNSURE)
    } catch (e) {
      toast(userMessage(e, unsure(e) ? UNSURE : 'L\'action n\'a pas abouti.'))
    }
    refocus.current = 'act'
    await read()
    inflight.current = false
    setBusy(false)
  }

  function retry() {
    refocus.current = 'retry'
    setFailed(false)
    void read()
  }

  // « Réessayer » d'un panneau disparaît pendant la relecture : le focus passe au h1, jamais sur body.
  function retryExtra() {
    title.current?.focus()
    setFailed(false)
    setExtra(null)
    void readExtra(++gen.current)
  }

  const allowed = !!view && (view.isOwn || view.isFriend || view.profile.is_public)
  const ready = missing || failed || (allowed ? extra !== null : !!view)
  const shown = allowed && extra !== 'private'
  const p = view?.profile
  const f = view?.friendship
  return (
    <div data-ready={ready ? '' : undefined} className="space-y-6">
      {missing ? (
        <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
          <h1 ref={lost} tabIndex={-1} className="text-xl font-bold outline-none">Joueur introuvable</h1>
          <Link href="/friends" className={link}>Retour aux amis</Link>
        </div>
      ) : !view || !p ? (
        failed ? <LoadError ref={retryButton} onRetry={retry} /> : <Loading label="Chargement du profil" />
      ) : (
        <>
          <PageHeader ref={title} title={p.username} icon={entry.icon}>
            {/* Le premier contrôle est celui de l'amitié : la cible du focus après une action. */}
            <div ref={actions} className="flex flex-wrap gap-3">
              {view.isOwn ? (
                <Link href="/profile" className={ghost}>Modifier mon profil</Link>
              ) : (
                <>
                  {view.isFriend ? (
                    <>
                      <Link href={`/dms?with=${p.id}`} className={primary}>Message</Link>
                      <Link href={`/trades/new?with=${p.id}`} className={ghost}>Proposer un échange</Link>
                    </>
                  ) : !f ? (
                    <button
                      type="button"
                      aria-disabled={busy || undefined}
                      onClick={() => void act(`add:${p.id}`, '/api/friends', { method: 'POST', body: JSON.stringify({ addressee_id: p.id }) },
                        `Demande envoyée à ${p.username}.`)}
                      className={primary}
                    >
                      Ajouter en ami
                    </button>
                  ) : f.requester_id === p.id ? (
                    <button
                      type="button"
                      aria-disabled={busy || undefined}
                      onClick={() => void act(`accept:${f.id}`, `/api/friends/${f.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'accept' }) },
                        `${p.username} fait maintenant partie de tes amis.`)}
                      className={primary}
                    >
                      Accepter sa demande
                    </button>
                  ) : (
                    <p tabIndex={-1} className="inline-flex min-h-11 items-center text-sm font-medium outline-none">Demande envoyée</p>
                  )}
                  <button type="button" onClick={() => setReporting(true)} className={ghost}>Signaler</button>
                </>
              )}
            </div>
          </PageHeader>

          <div className="card-frame flex flex-wrap items-center gap-6 p-6">
            {/* À côté du pseudo (h1) : décoratif, alt vide (D:753). Miniature Commons en lien direct, sans l'optimiseur de Next (D§8.5). */}
            {p.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.avatar_url} alt="" className="size-24 shrink-0 rounded-full object-cover" />
            ) : (
              <span aria-hidden="true" className="inline-flex size-24 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-light)] text-4xl font-bold text-[var(--color-accent)]">
                {[...p.username][0]?.toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1 space-y-3">
              <p className="text-sm text-[var(--color-foreground)]/70">{`Membre depuis ${formatMonthYear(p.created_at)}`}</p>
              {p.bio && <p className="whitespace-pre-line wrap-anywhere">{p.bio}</p>}
              {shown && extra && typeof extra === 'object' && (
                <ul aria-label="Cartes par rareté" className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold tabular-nums">
                  {RARITY.map((r) => (
                    <li key={r.code} title={r.label} style={{ color: `var(--color-rarity-${r.css})` }}>
                      <span aria-hidden="true">{r.code}</span>
                      <span className="sr-only">{r.label}</span> {formatInt(extra.counts[r.code] ?? 0)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {shown ? (
            <>
              {/* Onglets de /trades ; le seul panneau de l'onglet actif monté. shortcut: onglet en mémoire et non dans l'adresse (B13). */}
              <div role="tablist" aria-label="Vues du profil" className="flex flex-nowrap gap-x-1 overflow-x-auto border-b border-[var(--color-border)]">
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
                    onKeyDown={(e) => tabKey(e, TABS, tab, id, setTab)}
                    className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-4 text-sm font-semibold transition-colors focus-visible:-outline-offset-2 ${tab === t ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-b-2 border-transparent text-[var(--color-foreground)]/70 hover:text-[var(--color-foreground)]'}`}
                  >
                    {LABELS[t]}
                  </button>
                ))}
              </div>
              <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
                {tab === 'collection' ? (
                  <Collection username={username} onOpen={setOpen} onRetry={() => title.current?.focus()} />
                ) : !extra && !failed ? (
                  <Loading label="Chargement de la vitrine" />
                ) : !extra || extra === 'failed' ? (
                  // Vitrine ou raretés en échec, ou profil relu en échec avant elles : jamais un chargement sans fin.
                  <LoadError onRetry={retryExtra} />
                ) : extra.showcase.length ? (
                  <div className={grid}>
                    {extra.showcase.map((s) => (
                      <Card key={s.position} card={copyFace(s.user_card)} size="grid" count={s.user_card.count} isShiny={s.user_card.is_shiny}
                        onClick={() => setOpen(s.user_card.card)} />
                    ))}
                  </div>
                ) : (
                  <p className="card-frame p-6 text-center text-sm">Aucune carte en vitrine.</p>
                )}
              </div>
            </>
          ) : (
            <p className="card-frame p-6 text-center text-sm">Ce profil est réservé aux amis.</p>
          )}
        </>
      )}

      {/* Carte du catalogue (B2 : l'objet card porte id et wikipedia_url) : la modale en donne l'auteur et la licence de l'image (D:101). */}
      {open && <CardModal item={open} onClose={() => setOpen(null)} />}
      {reporting && p && <ReportModal user={p} onClose={() => setReporting(false)} />}
    </div>
  )
}

// Onglet « Collection » : 50 copies par page (wm.profile_collection), en base 0, et une recherche. Lu à chaque affichage (Activity compris),
// à chaque page, recherche ou « Réessayer » ; une réponse d'une requête quittée est jetée.
function Collection({ username, onOpen, onRetry }: { username: string; onOpen: (card: CatalogCard) => void; onRetry: () => void }) {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [reload, setReload] = useState(0)
  const [data, setData] = useState<{ q: string; items: CopyFace[]; total: number } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const query = new URLSearchParams({ page: String(page), ...(q ? { q } : {}) }).toString()
  const key = `${query}#${reload}`

  useEffect(() => {
    let live = true
    api<CollectionPage | null>(`/api/profile/${username}/collection?${query}`).then(
      (r) => {
        if (!live) return
        if (Array.isArray(r?.collection)) setData({ q, items: r.collection, total: r.total })
        else setFailedKey(key)
      },
      () => { if (live) setFailedKey(key) },
    )
    return () => {
      live = false
      setFailedKey(null)
    }
  }, [username, query, q, key])

  const search = (v: string) => {
    setPage(0)
    setQ(v)
  }

  return (
    <div className="space-y-6">
      <form role="search" onSubmit={(e) => { e.preventDefault(); search(text.trim()) }}>
        <input
          type="search"
          aria-label="Rechercher dans sa collection"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // Champ vidé (croix comprise) : retour à toute la collection.
            if (!e.target.value.trim() && q) search('')
          }}
          className={field}
        />
      </form>
      {failedKey === key ? (
        <LoadError onRetry={() => {
          // « Réessayer » disparaît pendant la relecture : le focus passe au h1, jamais sur body.
          onRetry()
          setReload((n) => n + 1)
        }} />
      ) : !data ? (
        <Loading label="Chargement de la collection" />
      ) : data.items.length ? (
        <>
          <div className={grid}>
            {data.items.map((c) => (
              <Card key={c.id} card={copyFace(c)} size="grid" count={c.count} isShiny={c.is_shiny} onClick={() => onOpen(c.card)} />
            ))}
          </div>
          <Pagination
            page={page}
            totalPages={Math.ceil(data.total / LIMIT)}
            onPage={(n) => {
              setPage(n)
              document.querySelector('main')?.scrollTo({ top: 0 })
            }}
          />
        </>
      ) : (
        <p className="card-frame p-6 text-center text-sm">{data.q ? 'Aucune carte ne correspond à ces filtres.' : 'Sa collection est vide.'}</p>
      )}
    </div>
  )
}
