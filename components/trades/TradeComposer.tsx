'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from 'react'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { ghost, link, primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { toast } from '@/components/ui/toast'
import { api, ApiError, apiOnce, calendarTz, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import type { RarityCode } from '@/lib/rarity'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import { buildBody, invertTrade, sideCount, type Picks } from './compose'
import type { Trade } from './types'

const entry = navEntry('/trades')
const field = 'min-h-11 min-w-0 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm placeholder:text-[var(--color-foreground)]/60'
const PAGE = 50
const LOAD_FAILED = 'Impossible de charger cette page.'
// Réponse perdue, 5xx ou corps illisible : l'échange a pu être créé ; relancé avec le même corps, il garde sa clé (apiOnce) et le serveur
// rejoue sa réponse.
const UNSURE = 'L\'envoi n\'a pas été confirmé : l\'échange a peut-être été proposé. Réessaie, il ne sera pas créé deux fois.'

type Copy = { id: string; card_id: string; count: number; snapshot_rarity: RarityCode; card: { wikipedia_title: string } }
type Collection = { collection: Copy[]; total: number; pendingTradeCardIds: string[] }
// Un panneau : filtre appliqué, dernière page lue (base 0), copies des pages lues.
type Side = { q: string; page: number; items: Copy[]; total: number; pending: string[] }
type Which = 'offer' | 'ask'
type Player = { id: string; username: string }
type Friendship = { status: string; requester_id: string; addressee_id: string; requester: Player; addressee: Player }
// Composer refusé : son texte et sa sortie.
type Blocked = { text: string; href: string; label: string }

const NOT_FRIENDS: Blocked = { text: 'Vous devez être amis pour échanger', href: '/friends', label: 'Amis' }
const CLOSED: Blocked = { text: 'Cet échange n\'est plus en attente (déjà traité)', href: '/trades', label: 'Retour aux échanges' }
const MISSING: Blocked = { text: 'Échange introuvable', href: '/trades', label: 'Retour aux échanges' }

// Page de 50 de /api/my-collection : la mienne, ou celle de l'ami (owned_by). Échec ou 2xx au corps illisible (api() rend null) → null.
const readPage = (owner: string | null, q: string, page: number) =>
  api<Collection | null>(`/api/my-collection?${new URLSearchParams({ ...(owner === null ? {} : { owned_by: owner }), ...(q ? { q } : {}), page: String(page) })}`)
    .then((r) => (Array.isArray(r?.collection) ? r : null), () => null)
const sideOf = (q: string, r: Collection): Side => ({ q, page: 0, items: r.collection, total: r.total, pending: r.pendingTradeCardIds })
const titles = (items: Copy[]) => Object.fromEntries(items.map((c) => [c.id, c.card.wikipedia_title]))

// /trades/new?with=<ami>[&parent=<échange>] (M4-15, P18). Remonté pour un autre ami ou un autre parent. Cachée par Activity, la page se rend
// avec l'adresse de la page visible, sans `with` : elle garde alors les siens, et son brouillon avec.
export function TradeComposer() {
  const params = useSearchParams()
  const w = params.get('with') ?? ''
  const p = params.get('parent') ?? ''
  const [shown, setShown] = useState({ w, p })
  if (w && (w !== shown.w || p !== shown.p)) setShown({ w, p })
  return <Composer key={`${shown.w}/${shown.p}`} withId={shown.w} parentId={shown.p || undefined} />
}

function Composer({ withId, parentId }: { withId: string; parentId?: string }) {
  const id = useId()
  const router = useRouter()
  const [head, setHead] = useState<{ me: string; friend: Player } | null>(null)
  const [blocked, setBlocked] = useState<Blocked | null>(null)
  const [failed, setFailed] = useState(false)
  const [sides, setSides] = useState<Record<Which, Side> | null>(null)
  const [picks, setPicks] = useState<Record<Which, Picks>>({ offer: {}, ask: {} })
  // Quantité en cours de saisie, affichée telle quelle jusqu'à la sortie du champ ; le choix, lui, est déjà borné à [0, count].
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null)
  const [wb, setWb] = useState<Record<Which, string>>({ offer: '', ask: '' })
  // user_card_id → card_id et titre, des pages lues et des éléments du parent ; jamais d'entrée retirée (P18).
  const [known, setKnown] = useState<{ cardOf: Record<string, string>; titleOf: Record<string, string> }>({ cardOf: {}, titleOf: {} })
  // Copies du parent : la contre-offre le clôt, son verrou ne compte pas pour elles.
  const [parentCopies, setParentCopies] = useState<string[]>([])
  // Lecture d'un panneau en cours (filtre, « Charger la suite ») ; envoi en cours. aria-disabled et garde, jamais disabled.
  const [loading, setLoading] = useState<Record<Which, boolean>>({ offer: false, ask: false })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef({ offer: false, ask: false })
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  // Générations : une lecture tardive n'écrase pas une plus récente ; la lecture de la page relance les deux panneaux en page 0.
  const gens = useRef({ head: 0, offer: 0, ask: 0 })
  const prefilled = useRef(false)
  // Cible du focus quand l'élément focalisé disparaît (« Réessayer », dernier « Charger la suite », « Retirer ») : gardée jusqu'à ce
  // qu'elle existe, prise seulement si le focus est tombé sur body.
  const refocus = useRef<(() => HTMLElement | null | undefined) | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const exit = useRef<HTMLAnchorElement>(null)

  const learn = (cardOf: Record<string, string>, titleOf: Record<string, string>) =>
    setKnown((k) => ({ cardOf: { ...k.cardOf, ...cardOf }, titleOf: { ...k.titleOf, ...titleOf } }))
  // Une page lue : card_id et titres retenus ; un choix au-delà de sa pile (parent prérempli, pile réduite depuis) ramené à son count.
  const reveal = (w: Which, items: Copy[]) => {
    learn(Object.fromEntries(items.map((c) => [c.id, c.card_id])), titles(items))
    // Pendant l'envoi, les choix restent ceux envoyés ; la lecture suivante bornera.
    if (inflight.current) return
    // Un choix ramené change le corps, donc la clé : l'alerte d'un envoi incertain (« pas créé deux fois ») ne vaut plus.
    if (items.some((c) => (picks[w][c.id] ?? 0) > c.count)) setError(null)
    setPicks((p) => ({ ...p, [w]: { ...p[w], ...Object.fromEntries(items.filter((c) => (p[w][c.id] ?? 0) > c.count).map((c) => [c.id, c.count])) } }))
  }

  // Lue à chaque affichage (Activity compris) et sur « Réessayer » : l'ami (session du navigateur, P16), le parent, la page 0 de chaque
  // panneau sous son filtre. Les choix restent ; la contre-offre n'est préremplie qu'une fois.
  const load = () => {
    const g = ++gens.current.head
    // Un panneau relu ou filtré après ce départ garde sa lecture, plus récente : celle-ci ne l'écrase pas.
    const go = ++gens.current.offer
    const ga = ++gens.current.ask
    const qs = { offer: sides?.offer.q ?? '', ask: sides?.ask.q ?? '' }
    void Promise.all([
      api<{ friendships: Friendship[] } | null>('/api/friends').then((r) => (Array.isArray(r?.friendships) ? r.friendships : null), () => null),
      createBrowserSupabase().auth.getSession().then(({ data }) => data.session?.user.id ?? null, () => null),
      parentId
        ? api<{ trade: Trade } | null>(`/api/trades/${encodeURIComponent(parentId)}`).then((r) => r?.trade ?? null,
          (e) => (e instanceof ApiError && (e.status === 404 || e.status === 400) ? 'missing' as const : null))
        : undefined,
      readPage(null, qs.offer, 0),
      readPage(withId, qs.ask, 0),
    ]).then(([rows, me, parent, offer, ask]) => {
      if (g !== gens.current.head) return
      const fresh = { offer: go === gens.current.offer, ask: ga === gens.current.ask }
      for (const w of ['offer', 'ask'] as const) if (fresh[w]) busy.current[w] = false
      setLoading((l) => ({ offer: !fresh.offer && l.offer, ask: !fresh.ask && l.ask }))
      const f = rows?.find((x) => x.status === 'accepted' && withId !== me && [x.requester_id, x.addressee_id].includes(withId))
      const friend = f && (f.requester_id === withId ? f.requester : f.addressee)
      const stop = (b: Blocked) => {
        setBlocked(b)
        setFailed(false)
      }
      if (rows && me && !friend) return stop(NOT_FRIENDS)
      if (parent === 'missing') return stop(MISSING)
      if (!rows || !me || !friend || parent === null || !offer || !ask) return setFailed(true)
      // Une contre-offre va à l'initiateur du parent : un autre `with` est traité comme un non-ami.
      if (parent && parent.initiator_id !== withId) return stop(NOT_FRIENDS)
      // P3 : un pending échu arrive déjà en expired.
      if (parent && parent.status !== 'pending') return stop(CLOSED)
      setBlocked(null)
      setFailed(false)
      setHead({ me, friend })
      setSides((s) => ({
        offer: s && !fresh.offer ? s.offer : sideOf(qs.offer, offer),
        ask: s && !fresh.ask ? s.ask : sideOf(qs.ask, ask),
      }))
      setParentCopies(parent ? parent.items.map((i) => i.user_card_id) : [])
      if (parent && !prefilled.current) {
        prefilled.current = true
        const inv = invertTrade(parent, me)
        // Copies du parent hors des pages lues comprises : leur card_id vient de lui.
        learn(inv.cardOf, Object.fromEntries(parent.items.map((i) => [i.user_card_id, i.card.wikipedia_title])))
        setPicks({ offer: inv.offer, ask: inv.ask })
        setWb({ offer: inv.wbOffer ? String(inv.wbOffer) : '', ask: inv.wbAsk ? String(inv.wbAsk) : '' })
      }
      // Après le préremplissage : ses quantités sont bornées aux piles lues.
      if (fresh.offer) reveal('offer', offer.collection)
      if (fresh.ask) reveal('ask', ask.collection)
    })
  }
  const onShow = useEffectEvent(load)
  useEffect(() => onShow(), [])

  useEffect(() => {
    const target = refocus.current?.()
    if (!target) return
    refocus.current = null
    if (document.activeElement === document.body) target.focus()
  })

  // Filtre (page 0, choix gardés) ou page suivante d'un panneau. Échec : un toast, le panneau reste tel quel.
  async function readSide(w: Which, q: string, page: number) {
    const g = ++gens.current[w]
    busy.current[w] = true
    setLoading((l) => ({ ...l, [w]: true }))
    const r = await readPage(w === 'offer' ? null : withId, q, page)
    if (g !== gens.current[w]) return
    busy.current[w] = false
    setLoading((l) => ({ ...l, [w]: false }))
    if (!r) return toast(LOAD_FAILED)
    reveal(w, r.collection)
    // Dernière page : « Charger la suite » disparaît sous le focus, qui va à la première copie arrivée. Filtre : une quantité de l'ancienne
    // liste focalisée pendant la lecture disparaît avec elle, le focus revient au filtre.
    const first = page ? (sides?.[w].items.length ?? 0) : -1
    refocus.current = () => {
      const panel = root.current?.querySelector(`[data-side="${w}"]`)
      const inputs = panel?.querySelectorAll<HTMLElement>('input[type="number"]')
      return first < 0 ? panel?.querySelector<HTMLElement>('input[type="search"]') : (inputs?.[first] ?? inputs?.[inputs.length - 1])
    }
    setSides((s) => s && {
      ...s,
      [w]: {
        q, page, total: r.total, pending: r.pendingTradeCardIds,
        // Pages par décalage : une copie arrivée entre deux lectures décale la suite, une copie déjà listée n'est pas reprise.
        items: page ? [...s[w].items, ...r.collection.filter((c) => !s[w].items.some((x) => x.id === c.id))] : r.collection,
      },
    })
  }

  // Ni filtre ni suite pendant l'envoi : leur lecture bornerait un choix, donc changerait le corps envoyé.
  function filter(e: FormEvent<HTMLFormElement>, w: Which) {
    e.preventDefault()
    if (inflight.current) return
    void readSide(w, String(new FormData(e.currentTarget).get('q') ?? '').trim(), 0)
  }

  function more(w: Which) {
    if (busy.current[w] || inflight.current || !sides) return
    void readSide(w, sides[w].q, sides[w].page + 1)
  }

  // Toute modification fait un autre corps, donc une autre clé : l'alerte d'un envoi incertain (« pas créé deux fois ») ne vaut plus.
  // Rien pendant l'envoi : une issue inconnue doit valoir pour le corps envoyé, que la relance renvoie sous la même clé.
  const setQty = (w: Which, copy: string, text: string, max: number) => {
    if (inflight.current) return
    setError(null)
    setDraft({ id: copy, text })
    setPicks((p) => ({ ...p, [w]: { ...p[w], [copy]: Math.min(Math.max(Math.trunc(Number(text)) || 0, 0), max) } }))
  }

  const remove = (w: Which, copy: string, i: number) => {
    if (inflight.current) return
    // La ligne disparaît sous le focus : le « Retirer » qui prend sa place, sinon le filtre du panneau.
    refocus.current = () => {
      const panel = root.current?.querySelector(`[data-side="${w}"]`)
      const buttons = panel?.querySelectorAll<HTMLElement>('[data-picks] button')
      return buttons?.[Math.min(i, buttons.length - 1)] ?? panel?.querySelector<HTMLElement>('input[type="search"]')
    }
    setError(null)
    setPicks((p) => ({ ...p, [w]: { ...p[w], [copy]: 0 } }))
  }

  const setAmount = (w: Which, text: string) => {
    if (inflight.current) return
    setError(null)
    setWb((x) => ({ ...x, [w]: text.replace(/\D/g, '') }))
  }

  const empty = !sideCount(picks.offer) && !sideCount(picks.ask)

  async function send() {
    if (inflight.current || empty || !head) return
    inflight.current = true
    setSending(true)
    setError(null)
    const body = JSON.stringify(buildBody({
      recipientId: head.friend.id, me: head.me, offer: picks.offer, ask: picks.ask, cardOf: known.cardOf,
      wbOffer: Number(wb.offer), wbAsk: Number(wb.ask), parentId,
    }))
    try {
      // Intention = corps complet (P18) : la relance d'un même corps rejoue, un corps changé est une nouvelle demande.
      const t = await apiOnce<Trade | null>(keys.current, body, '/api/trades', { method: 'POST', body, headers: calendarTz() })
      // 2xx au corps illisible : clé gardée par apiOnce, une issue inconnue comme un 5xx.
      if (!t?.id) throw new Error('Réponse illisible')
      toast(parentId ? 'Contre-offre envoyée.' : `Échange proposé à ${head.friend.username}.`)
      // Page gardée par Activity : au retour, plus de choix, donc aucun second envoi du même échange.
      setPicks({ offer: {}, ask: {} })
      setWb({ offer: '', ask: '' })
      router.push(`/trades/${t.id}`)
    } catch (e) {
      // Refus : le message du serveur. Issue inconnue : la clé reste ; un 503 codé (BUSY) garde son texte.
      setError(userMessage(e, unsure(e) ? UNSURE : 'L\'action n\'a pas abouti.'))
    } finally {
      inflight.current = false
      setSending(false)
    }
  }

  function retry() {
    refocus.current = () => retryButton.current ?? exit.current ?? root.current?.querySelector<HTMLElement>('input[type="search"]')
    setFailed(false)
    load()
  }

  const panel = (w: Which, title: string, label: string) => {
    const s = sides![w]
    const p = picks[w]
    const chosen = Object.keys(p).filter((c) => p[c] > 0)
    return (
      <section data-side={w} aria-labelledby={`${id}-${w}`} className="card-frame min-w-0 space-y-3 p-4">
        <h2 id={`${id}-${w}`} className="text-lg font-bold">{`${title} (${formatInt(sideCount(p))}/100)`}</h2>
        {/* Envoi sur Entrée (un seul champ : soumission implicite) ; le panneau revient en page 0, les choix restent. */}
        <form onSubmit={(e) => filter(e, w)}>
          <input type="search" name="q" aria-label={label} placeholder={`${label}…`} className={`${field} w-full`} />
        </form>
        {s.items.length ? (
          <ul className="divide-y divide-[var(--color-border)]">
            {s.items.map((c) => {
              const t = c.card.wikipedia_title
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-medium wrap-anywhere">{t}</span>
                    <span id={`${id}-${c.id}`} className="text-[var(--color-foreground)]/70">
                      {`${c.snapshot_rarity} · ×${formatInt(c.count)}`}
                      {/* M4-2 : marquée, toujours offrable (la seconde acceptation échouera si la première passe). */}
                      {(s.pending.includes(c.id) || s.pending.includes(c.card_id)) && !parentCopies.includes(c.id) && (
                        <span className="text-amber-600"> · Déjà dans un échange</span>
                      )}
                    </span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={c.count}
                    aria-label={`Quantité de ${t}`}
                    aria-describedby={`${id}-${c.id}`}
                    value={draft?.id === c.id ? draft.text : String(p[c.id] ?? 0)}
                    readOnly={sending}
                    onChange={(e) => setQty(w, c.id, e.target.value, c.count)}
                    onBlur={() => setDraft(null)}
                    className={`${field} w-20`}
                  />
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-foreground)]/70">Aucune carte.</p>
        )}
        {(s.page + 1) * PAGE < s.total && (
          <button type="button" aria-disabled={loading[w] || sending || undefined} onClick={() => more(w)} className={`${ghost} justify-center`}>
            Charger la suite
          </button>
        )}
        {/* Tous les choix, ceux hors des pages lues compris (contre-offre, filtre changé) (P18). */}
        {chosen.length > 0 && (
          <ul data-picks aria-label="Tes choix" className="space-y-2 border-t border-[var(--color-border)] pt-3">
            {chosen.map((c, i) => (
              <li key={c} className="flex flex-wrap items-center justify-between gap-2">
                <span id={`${id}-pick-${c}`} className="min-w-0 text-sm wrap-anywhere">{`${known.titleOf[c]} ×${formatInt(p[c])}`}</span>
                <button type="button" aria-disabled={sending || undefined} aria-describedby={`${id}-pick-${c}`} onClick={() => remove(w, c, i)} className={ghost}>Retirer</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  const ready = blocked || (head && sides) || failed
  return (
    <div ref={root} data-ready={ready ? '' : undefined} className="space-y-6">
      <PageHeader title={parentId ? 'Contre-offre' : 'Nouvel échange'} icon={entry.icon} />
      {blocked ? (
        <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm">{blocked.text}</p>
          <Link ref={exit} href={blocked.href} className={link}>{blocked.label}</Link>
        </div>
      ) : head && sides ? (
        <>
          <p className="wrap-anywhere">{`Échange avec ${head.friend.username}`}</p>
          <div className="grid gap-6 md:grid-cols-2">
            {panel('offer', 'Tu offres', 'Filtrer mes cartes')}
            {panel('ask', 'Tu demandes', 'Filtrer ses cartes')}
          </div>
          <div className="flex flex-wrap gap-4">
            {(['offer', 'ask'] as const).map((w) => (
              <label key={w} className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                {w === 'offer' ? 'Wikibidous offerts' : 'Wikibidous demandés'}
                {/* Chiffres seuls, 5 au plus (R:600) ; le plafond de 10 000 est celui du serveur (400 en alerte). Vide = 0. */}
                <input
                  inputMode="numeric"
                  maxLength={5}
                  autoComplete="off"
                  placeholder="0"
                  value={wb[w]}
                  readOnly={sending}
                  onChange={(e) => setAmount(w, e.target.value)}
                  // maxLength couperait « 10 000 » collé avant le retrait de l'espace : le texte collé à la sélection, les chiffres seuls, puis les
                  // 5 premiers ; un texte sans chiffre ne change rien.
                  onPaste={(e) => {
                    e.preventDefault()
                    const t = e.currentTarget
                    const clip = e.clipboardData.getData('text')
                    if (!/\d/.test(clip)) return
                    setAmount(w, (t.value.slice(0, t.selectionStart ?? 0) + clip + t.value.slice(t.selectionEnd ?? t.value.length)).replace(/\D/g, '').slice(0, 5))
                  }}
                  className={`${field} w-32`}
                />
              </label>
            ))}
          </div>
          <div className="space-y-3">
            <button type="button" aria-disabled={empty || sending || undefined} onClick={() => void send()} className={primary}>
              {parentId ? 'Envoyer la contre-offre' : 'Proposer l\'échange'}
            </button>
            {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
          </div>
        </>
      ) : failed ? (
        <LoadError ref={retryButton} onRetry={retry} />
      ) : (
        <Loading label="Chargement de l'échange" />
      )}
    </div>
  )
}
