'use client'

import { ArrowLeft, Bookmark, BookmarkCheck, ChartLine, X } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Card } from '@/components/card/Card'
import { BidBox, type BidResult } from '@/components/market/BidBox'
import { Countdown } from '@/components/market/Countdown'
import { MarketPanel } from '@/components/market/MarketPanel'
import { auctionFace, type Auction } from '@/components/market/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { ghost } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { WCoin } from '@/components/ui/WCoin'
import { api, ApiError, apiOnce, unsure, userMessage } from '@/lib/api'
import { serverNow, subscribeClock } from '@/lib/clock'
import { formatDateTime, formatInt } from '@/lib/format'
import { usePoll } from '@/lib/poll'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import { readWished, saveWished } from '@/lib/wishlist'

type Bid = { amount: number; placed_at: string; bidder: { username: string } }
type Detail = { auction: Auction; bids: Bid[] }

const entry = navEntry('/marketplace')
// Le détail est partagé en cache et peut être servi jusqu'à 2 s après une écriture (profil auction, M3-22) : une lecture partie avant
// la fin de ce délai est jetée, elle déferait la réponse d'une mise, d'une baisse ou d'un règlement.
const STALE_MS = 2_000
// Réponse perdue ou 5xx : l'action a pu avoir lieu ; relancée, elle garde sa clé (apiOnce) et le serveur rejoue sa réponse.
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu. L\'enchère se met à jour.'
const label = 'text-[var(--color-foreground)]/70'
const row = 'flex items-center justify-between gap-2'
const round = 'inline-flex size-11 items-center justify-center rounded-full border border-[var(--color-foreground)]/40 transition-colors hover:bg-[var(--color-surface-light)] aria-disabled:cursor-progress'
const primary = 'inline-flex min-h-11 items-center justify-center self-start rounded-xl bg-[var(--color-accent)] px-5 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-progress aria-disabled:opacity-80'

// Instant t passé sur l'horloge du serveur, relu par l'horloge partagée : rendu seulement quand la réponse change.
const usePassed = (t: number) => useSyncExternalStore(subscribeClock, () => serverNow() >= t, () => false)

// /marketplace/[auctionId] (M3-24). Aucun id d'élément (M3-2) : aria-label et data-* seulement.
export function AuctionClient() {
  const { auctionId: id } = useParams<{ auctionId: string }>()
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // Joueur de la session du navigateur (P18) : la réponse du détail est la même pour tous.
  const [uid, setUid] = useState<string | null>(null)
  const [wished, setWished] = useState<boolean | null>(null)
  const [wishing, setWishing] = useState(false)
  const [analysis, setAnalysis] = useState(false)
  // Formulaire « Baisser le prix » : null fermé, sinon la valeur du champ.
  const [newPrice, setNewPrice] = useState<string | null>(null)
  // « Retirer », « Valider » et « Finaliser la vente » : une requête à la fois, aria-disabled et garde, jamais disabled (D§7.0).
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const hold = useRef(0)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const outcome = useRef<HTMLDivElement>(null)
  const a = detail?.auction

  const read = () => {
    const started = Date.now()
    return api<Detail>(`/api/marketplace/${id}`).then(
      (d) => {
        if (started < hold.current) return
        setDetail(d)
        setFailed(null)
      },
      (e) => {
        // Inconnue ou retirée (404), adresse invalide (400) : « Auction not found ». Autre échec : l'enchère affichée reste.
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setMissing(true)
        else setFailed(userMessage(e, 'L\'enchère n\'a pas pu être chargée.'))
      },
    )
  }
  // Lue à chaque affichage (Activity compris), puis toutes les 2 s sous 2 min restantes, sinon 10 s (C15) ; plus rien une fois réglée.
  const onShow = useEffectEvent(read)
  useEffect(() => void onShow(), [])
  usePoll(read, () => (a && Date.parse(a.end_at) - serverNow() < 120_000 ? 2_000 : 10_000), !missing && (!a || a.status === 'active'))

  useEffect(() => {
    void createBrowserSupabase().auth.getSession().then(({ data }) => setUid(data.session?.user.id ?? null))
  }, [])
  const cardId = a?.card_id
  useEffect(() => {
    if (!cardId) return
    let live = true
    // Lecture en échec : l'état reste inconnu, affiché comme absent (un ajout en double revient en 23505, traité comme réussi).
    void readWished(cardId).then((w) => { if (live) setWished(w) })
    return () => { live = false }
  }, [cardId])

  const ended = usePassed(a ? Date.parse(a.end_at) : NaN)
  // Baisse permise après la moitié de la durée (D§6.4), comptée sur end_at − created_at.
  const half = usePassed(a ? (Date.parse(a.created_at) + Date.parse(a.end_at)) / 2 : NaN)

  // Réglée sous les yeux du joueur (« Finaliser la vente », ou une relecture) : le bouton ou le champ pressé a disparu, le focus va au
  // résultat plutôt que sur body.
  const status = a?.status
  const was = useRef(status)
  useEffect(() => {
    if (was.current === 'active' && status !== 'active' && document.activeElement === document.body) outcome.current?.focus()
    was.current = status
  }, [status])

  // Réponse d'une écriture : l'enchère affichée la prend, et les lectures encore servies par le cache d'avant sont jetées.
  const apply = (patch: Partial<Auction>) => {
    hold.current = Date.now() + STALE_MS
    setDetail((d) => d && { ...d, auction: { ...d.auction, ...patch } })
  }

  async function act<T>(intent: string, path: string, init: RequestInit, done: (r: T) => void) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      done(await apiOnce<T>(keys.current, intent, path, init))
    } catch (e) {
      setError(userMessage(e, unsure(e) ? UNSURE : 'L\'action n\'a pas abouti.'))
      if (unsure(e)) void read()
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const cancel = () => act('cancel', `/api/marketplace/${id}`, { method: 'DELETE' }, () => {
    toast('Enchère retirée : la carte est revenue dans ta collection.')
    router.push('/marketplace')
  })

  function reprice(e: FormEvent) {
    e.preventDefault()
    void act<{ base_amount: number; base_repriced_at: string }>('reprice', `/api/marketplace/${id}/reprice`, {
      method: 'POST',
      body: JSON.stringify({ new_base_amount: Number(newPrice) }),
    }, (r) => {
      toast(`Prix baissé à ${formatInt(r.base_amount)} wikibidous`)
      setNewPrice(null)
      apply({ base_amount: r.base_amount, base_repriced_at: r.base_repriced_at })
      // « Baisser le prix » et « Valider » disparaissent : le focus passe à « Retirer », jamais sur body.
      requestAnimationFrame(() => cancelButton.current?.focus())
    })
  }

  const settle = () => act<{ auction: Auction }>('settle', `/api/marketplace/${id}/settle`, { method: 'POST' }, (r) => apply(r.auction))

  function onBid(r: BidResult) {
    apply({ current_bid: r.current_bid, end_at: r.end_at, min_next_bid: r.min_next_bid, current_bidder_id: uid })
    // L'historique vient de la lecture : relue juste après le délai du cache.
    setTimeout(() => void read(), STALE_MS + 100)
  }

  async function toggleWish() {
    if (!a || wishing) return
    setWishing(true)
    const next = !wished
    if (await saveWished(a.card_id, next)) setWished(next)
    else toast('La liste de souhaits n\'a pas pu être mise à jour.')
    setWishing(false)
  }

  const back = (
    <Link href="/marketplace" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--color-accent-light)] underline-offset-2 hover:underline">
      <ArrowLeft className="size-4" />
      Retour au marché
    </Link>
  )
  // En anglais, comme l'original (parité D§8.2).
  if (missing) {
    return (
      <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <h1 className="text-xl font-bold">Auction not found</h1>
        {back}
      </div>
    )
  }
  if (!a || !detail) {
    if (!failed) return <Loading label="Chargement de l'enchère" />
    // Le polling relance la lecture toutes les 10 s.
    return (
      <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <p role="alert" className="text-sm">{failed}</p>
        {back}
      </div>
    )
  }

  const me = (who: string | null) => !!uid && who === uid
  const active = a.status === 'active'
  const seller = me(a.seller_id)
  const maxPrice = Math.floor(a.listing_base_amount / 2)
  const canCancel = seller && active && a.current_bid === null
  // P25 : sans baisse possible (maxPrice < 1), pas de bouton.
  const canReprice = canCancel && a.base_repriced_at === null && half && maxPrice >= 1
  return (
    <>
      {back}
      <div className="flex flex-col gap-6 md:flex-row">
        <div className="flex shrink-0 justify-center">
          <Card card={auctionFace(a)} isShiny={a.is_shiny} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <PageHeader title={a.card.wikipedia_title} icon={entry.icon}>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                aria-label={wished ? 'Retirer de ma liste de souhaits' : 'Ajouter à ma liste de souhaits'}
                aria-pressed={!!wished}
                aria-disabled={wishing || undefined}
                onClick={() => void toggleWish()}
                className={round}
              >
                {wished ? <BookmarkCheck className="size-5 text-[var(--color-accent)]" /> : <Bookmark className="size-5" />}
              </button>
              <button type="button" aria-label="Analyse du marché" onClick={() => setAnalysis(true)} className={round}>
                <ChartLine className="size-5" />
              </button>
            </div>
          </PageHeader>
          <p className="text-sm">{`Vendu par ${a.seller.username}`}</p>
          <div ref={outcome} tabIndex={-1} className="flex flex-wrap gap-x-3 text-sm font-semibold outline-none empty:hidden">
            {active && me(a.current_bidder_id) && <p className="text-[var(--color-accent-light)]">En tête</p>}
            {a.status === 'settled_sold' && me(a.winner_id) && <p className="text-[var(--color-accent-light)]">Remportée</p>}
            {a.status === 'settled_sold' && <p>{`Vendue pour ${formatInt(a.final_price ?? 0)} wikibidous`}</p>}
            {a.status === 'settled_unsold' && <p className={label}>Invendue</p>}
          </div>
          <div className="card-frame max-w-sm space-y-2 p-4 text-sm">
            <p className={row}>
              <span className={label}>{a.current_bid === null ? 'Mise de départ' : 'Mise actuelle'}</span>
              <span className="inline-flex items-center gap-1 font-semibold tabular-nums">
                {formatInt(a.current_bid ?? a.base_amount)}
                <span className="sr-only"> wikibidous</span>
                <WCoin />
              </span>
            </p>
            <p className={row}>
              <span className={label}>Durée</span>
              <Countdown endAt={a.end_at} over={!active} />
            </p>
          </div>
          {active && uid && !seller && <BidBox auction={a} onBid={onBid} />}
          {canCancel && (
            <div className="flex flex-wrap gap-3">
              <button ref={cancelButton} type="button" aria-disabled={busy || undefined} onClick={() => void cancel()} className={`${ghost} justify-center`}>
                Retirer
              </button>
              {canReprice && (
                <button
                  type="button"
                  aria-expanded={newPrice !== null}
                  onClick={() => setNewPrice(newPrice === null ? String(maxPrice) : null)}
                  className={`${ghost} justify-center`}
                >
                  Baisser le prix
                </button>
              )}
            </div>
          )}
          {canReprice && newPrice !== null && (
            <form onSubmit={reprice} className="flex gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={maxPrice}
                step={1}
                required
                autoFocus
                aria-label="Nouveau prix"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                className="min-h-11 w-32 min-w-0 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm tabular-nums"
              />
              <button type="submit" aria-disabled={busy || undefined} className={primary}>Valider</button>
            </form>
          )}
          {active && ended && (
            <button type="button" aria-disabled={busy || undefined} onClick={() => void settle()} className={primary}>
              Finaliser la vente
            </button>
          )}
          {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
          {detail.bids.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-lg font-bold">Historique des mises</h2>
              <ol aria-label="Historique des mises" className="card-frame divide-y divide-[var(--color-border)] text-sm">
                {detail.bids.map((b) => (
                  <li key={`${b.placed_at}-${b.amount}`} className="px-4 py-2 tabular-nums">
                    {`${b.bidder.username} · ${formatInt(b.amount)} wikibidous · `}
                    <time dateTime={b.placed_at}>{formatDateTime(b.placed_at)}</time>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
      {analysis && (
        <Modal
          onClose={() => setAnalysis(false)}
          label="Analyse du marché"
          className="card-frame relative w-full max-w-md animate-fade-in-up p-6 max-h-[90vh] overflow-y-auto"
        >
          <button
            type="button"
            aria-label="Fermer"
            onClick={() => setAnalysis(false)}
            className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-light)]"
          >
            <X className="size-6" />
          </button>
          <h2 className="mb-4 pr-10 text-xl font-bold">Analyse du marché</h2>
          <MarketPanel cardId={a.card_id} />
        </Modal>
      )}
    </>
  )
}
