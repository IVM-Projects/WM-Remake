'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Fragment, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { DeckSlots } from '@/components/battle/DeckSlots'
import { QuizForm, type Verdict } from '@/components/battle/QuizForm'
import { allows, isOpen, toFace, type AnswerResult, type Battle, type BattleDetail, type PendingAttack, type Turn } from '@/components/battle/types'
import { Card } from '@/components/card/Card'
import { Countdown } from '@/components/market/Countdown'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { ghost, link, primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { api, ApiError, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatDateTime, formatInt, wikibidous } from '@/lib/format'
import { usePoll } from '@/lib/poll'
import { BattleParams } from '@/lib/schemas'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/battle')
// Réponse perdue ou 5xx : l'action a pu avoir lieu ; relancée, elle garde sa clé (apiOnce) et le serveur rejoue sa réponse.
const ARENA_UNSURE = `${UNSURE} La bataille se met à jour.`
const danger = 'inline-flex min-h-11 items-center rounded-xl bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800 aria-disabled:cursor-progress aria-disabled:opacity-80'
const hint = 'text-sm text-[var(--color-foreground)]/70'
const stateLine = 'font-semibold outline-none wrap-anywhere'
type Action = 'accept' | 'decline' | 'withdraw_invite' | 'forfeit' | 'submit_deck' | 'submit_attack' | 'submit_single_answer'
type Reply = BattleDetail & Partial<AnswerResult>
type Question = PendingAttack['questions'][number]
type Source = { title: string; url: string }
// Retour de la dernière réponse, pris à l'envoi (question, h3, source) : affiché devant l'état relu jusqu'à « Continuer ».
type Answered = { question: Question; k: number; n: number; source: Source | null; verdict: Verdict }
// Cible du focus : le h2 de l'arène, la ligne d'état de l'écran, son premier contrôle utile, le retour d'une réponse.
type Target = 'head' | 'line' | 'first' | 'verdict'

const readable = (r: unknown): r is Reply =>
  typeof (r as Reply | null)?.battle?.id === 'string' && typeof (r as Reply | null)?.battle?.status === 'string'

// Écran affiché à `me` : sa clé change quand ce qu'il a sous les yeux change (pas le compte des réponses vu par l'attaquant).
function screenOf(b: Battle, me: string): string {
  const g = b.game_state
  switch (b.status) {
    case 'pending':
      return b.opponent_id === me ? 'invited' : 'inviting'
    case 'deck_selection':
    case 'generating_quizzes':
      return g?.players[me] ? 'deck-done' : 'deck'
    case 'active': {
      const pa = g?.phase === 'quiz' ? g.pendingAttack : null
      if (pa) return pa.defenderId === me ? `quiz:${pa.questions.find((q) => !pa.answered.includes(q.id))?.id}` : `quizzed:${g?.turnNumber}`
      return `${g?.currentTurnUserId === me ? 'attack' : 'attacked'}:${g?.turnNumber}`
    }
    default:
      return b.status
  }
}

// /battle/[id] (D§7.7, R§3.9) : défi, choix du deck, attaque, quiz une question à la fois, journal, fin et récompense, abandon. Relue à chaque
// affichage (Activity compris) et toutes les 3 s tant qu'elle est ouverte ; n'affiche que ce que le serveur rend (M5a-10, C23). Aucun id fixe.
export function ArenaClient() {
  const { id } = useParams<{ id: string }>()
  const uid = useId()
  const bad = !BattleParams.safeParse({ battleId: id }).success
  const [detail, setDetail] = useState<Reply | null>(null)
  // Joueur de la session du navigateur (P16) : undefined tant qu'elle n'est pas lue, null sans session (une lecture en échec).
  const [me, setMe] = useState<string | null>()
  const [missing, setMissing] = useState(bad)
  const [failed, setFailed] = useState(false)
  const [answered, setAnswered] = useState<Answered | null>(null)
  // Confirmation d'abandon ouverte, avec ce qu'elle annonce : elle ne vaut que tant que la phase est la même.
  const [confirm, setConfirm] = useState<'cancel' | 'lose' | null>(null)
  // Une action à la fois : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState(false)
  // Échec de la dernière action (role=alert), affiché tant que l'écran auquel il s'attache reste : l'écran relu après un refus, l'écran du
  // départ pour une issue inconnue.
  const [error, setError] = useState<{ text: string; at: string | null } | null>(null)
  const inflight = useRef(false)
  // Intention dont la requête est en vol : son issue n'est pas connue, une relecture ne décide pas de sa clé.
  const flying = useRef<string | null>(null)
  const keys = useRef(new Map<string, string>())
  // Génération des lectures : une lecture partie avant la dernière, ou avant la réponse d'une écriture (le hold), ne remet pas l'ancien état.
  const gen = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLHeadingElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const back = useRef<HTMLAnchorElement>(null)
  // Écran du dernier rendu (screenOf, ou 'answered') : celui auquel une issue inconnue s'attache, et le repère d'un écran changé.
  const shown = useRef<string | null>(null)
  // Cible posée par une action, « Continuer » ou « Réessayer », prise après le rendu de l'écran attendu (`view`, null : le premier écran
  // d'arène), si le focus est tombé sur body. L'effet d'un rendu précédent (poll), vidé juste avant le nouveau, ne la prend pas.
  const refocus = useRef<{ t: Target; view: string | null } | null>(null)

  // L'intention gardée que l'état relu refuse (deck posé, phase changée, question répondue) : sa clé est oubliée.
  const prune = (b: Battle) => {
    if (!me) return
    for (const k of keys.current.keys()) if (k !== flying.current && !allows(b, me, k)) keys.current.delete(k)
  }

  // Rend la bataille appliquée, sinon null.
  const read = (): Promise<Battle | null> => {
    const g = ++gen.current
    return api<Reply | null>(`/api/battles/${id}`).then(
      (r) => {
        if (g !== gen.current) return null
        // 2xx au corps illisible (api() rend null) ou sans bataille : une lecture en échec ; l'état affiché reste.
        if (!readable(r)) {
          setFailed(true)
          return null
        }
        prune(r.battle)
        // Partie finie ailleurs (abandon adverse, inactivité) pendant le retour d'une réponse : le retour reste jusqu'à « Continuer », mais
        // « Abandonner » disparaît ; le focus qu'il portait va au retour.
        if (answered && detail && isOpen(detail.battle) && !isOpen(r.battle)) refocus.current = { t: 'verdict', view: 'answered' }
        setDetail(r)
        setFailed(false)
        return r.battle
      },
      (e) => {
        if (g !== gen.current) return null
        // Inconnue ou d'autres joueurs (404), adresse invalide (400) : « Bataille introuvable ». Autre échec : l'état affiché reste.
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setMissing(true)
        else setFailed(true)
        return null
      },
    )
  }
  const readMe = () => createBrowserSupabase().auth.getSession().then(({ data }) => setMe(data.session?.user.id ?? null), () => setMe(null))
  const onShow = useEffectEvent(() => {
    if (!bad) void read()
  })
  useEffect(() => onShow(), [])
  useEffect(() => void readMe(), [])
  const over = missing || (!!detail && !isOpen(detail.battle))
  // Arrêté pendant une action : un passage ferait jeter la relecture qui suit un refus (génération), et l'alerte perdrait son écran.
  usePoll(read, 3_000, !over && !busy)
  // Page quittée puis gardée par Activity : on ne la retrouve pas avec la confirmation ouverte.
  useLayoutEffect(() => () => setConfirm(null), [])

  const b = detail?.battle
  // Écran affiché ; null sans arène (chargement, échec, introuvable, même une bataille déjà lue).
  const view = b && me && !missing ? (answered ? 'answered' : screenOf(b, me)) : null

  // Focus jamais sur body : la cible posée, sinon, l'écran changé (poll, refus relu), son premier contrôle utile, sinon le h2. Rien si le
  // joueur a mis le focus ailleurs. Sans arène (relecture en échec ou introuvable), « Réessayer » ou « Retour aux batailles ».
  useEffect(() => {
    if (!view) {
      // Arène ou échec devenus introuvables sous le focus, ou cible posée par « Réessayer » : « Retour aux batailles » ou « Réessayer ».
      const lost = missing && shown.current !== null && shown.current !== 'missing'
      // Repère : l'arène qui revient après un échec (poll) est un écran changé.
      if (failed || missing) shown.current = missing ? 'missing' : 'failed'
      if ((refocus.current || lost) && (failed || missing) && document.activeElement === document.body) {
        refocus.current = null
        ;(missing ? back : retryButton).current?.focus()
      }
      return
    }
    const changed = shown.current !== null && shown.current !== view
    shown.current = view
    const r = refocus.current
    const mine = r && (r.view === null || r.view === view)
    if (mine) refocus.current = null
    const t = mine ? r.t : changed ? 'first' : null
    if (!t || document.activeElement !== document.body) return
    ;((t === 'head' ? null : root.current?.querySelector<HTMLElement>(`[data-${t}]`)) ?? head.current)?.focus()
  })

  // Une écriture : la bataille rendue est appliquée (hold : les lectures parties avant sont jetées), `done` en tire la cible du focus et ce
  // qui doit paraître dans le même rendu. Refus : l'alerte, puis la bataille relue ; issue inconnue : l'incertitude, la clé gardée, puis relue.
  async function act(action: Action, payload: object, intent: string, done: (r: Reply) => Target) {
    if (inflight.current) return
    // Avant tout await : l'incertitude s'attache à l'écran du départ, jamais à une relecture faite pendant la requête.
    const at = shown.current
    inflight.current = true
    flying.current = intent
    setBusy(true)
    setError(null)
    try {
      const r = await apiOnce<Reply | null>(keys.current, intent, `/api/battles/${id}`, { method: 'PATCH', body: JSON.stringify({ action, ...payload }) })
      // 2xx illisible : apiOnce a gardé la clé, l'issue est inconnue.
      if (!readable(r)) throw new Error('Réponse illisible')
      gen.current++
      const t = done(r)
      refocus.current = { t, view: t === 'verdict' ? 'answered' : me ? screenOf(r.battle, me) : null }
      setDetail(r)
    } catch (e) {
      flying.current = null
      if (unsure(e)) {
        setError({ text: userMessage(e, ARENA_UNSURE), at })
        await read()
      } else {
        // Refus : la bataille relue, l'alerte attachée à l'écran qu'elle montre (sinon à celui du départ).
        const text = userMessage(e, 'L\'action n\'a pas abouti.')
        const fresh = await read()
        setError({ text, at: answered ? 'answered' : fresh && me ? screenOf(fresh, me) : at })
      }
    } finally {
      flying.current = null
      inflight.current = false
      setBusy(false)
    }
  }

  function attack(card: string) {
    if (inflight.current) return
    // Une seule attaque vaut : la clé gardée d'une autre carte (issue inconnue) rejouerait sa réponse stockée (DG:629).
    for (const k of keys.current.keys()) if (k.startsWith(`submit_attack:${id}:`) && k !== `submit_attack:${id}:${card}`) keys.current.delete(k)
    void act('submit_attack', { attack_card_id: card }, `submit_attack:${id}:${card}`, () => 'line')
  }

  // Le texte de la bonne réponse est lu dans les options de la question affichée à l'envoi : après la dernière, pendingAttack est nul.
  const answer = (q: Question, choice: string, k: number, n: number, source: Source | null) =>
    void act('submit_single_answer', { questionId: q.id, answerId: choice }, `submit_single_answer:${id}:${q.id}`, (r) => {
      const right = q.options.find((o) => o.id === r.correct_answer_id)?.text ?? ''
      const correct = r.correct === true
      // Réponse enregistrée ailleurs (autre onglet, rejeu) qui contredit le choix affiché : aucune radio cochée plutôt qu'un choix démenti.
      setAnswered({ question: q, k, n, source, verdict: { choice: (choice === r.correct_answer_id) === correct ? choice : null, correct, right } })
      return 'verdict'
    })

  function forfeit() {
    setConfirm(null)
    // Pendant le retour d'une réponse aussi : l'écran de fin le remplace.
    void act('forfeit', {}, `forfeit:${id}`, () => {
      setAnswered(null)
      return 'first'
    })
  }

  function retry() {
    refocus.current = { t: 'head', view: null }
    setFailed(false)
    if (me === null) {
      setMe(undefined)
      void readMe()
    }
    void read()
  }

  const ready = (detail && me) || failed || missing || me === null
  if (missing) {
    return (
      <div data-ready="" className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
        <h1 className="text-xl font-bold">Bataille introuvable</h1>
        <Link ref={back} href="/battle" className={link}>Retour aux batailles</Link>
      </div>
    )
  }
  if (!b || !me) {
    return (
      <div data-ready={ready ? '' : undefined}>
        {failed || me === null ? <LoadError ref={retryButton} onRetry={retry} /> : <Loading label="Chargement de la bataille" />}
      </div>
    )
  }

  const g = b.game_state
  const reward = detail?.reward ?? null
  const pa = g?.phase === 'quiz' ? g.pendingAttack : null
  const [mine, theirs] = b.challenger_id === me ? [b.challenger, b.opponent] : [b.opponent, b.challenger]
  const choosing = b.status === 'deck_selection' || b.status === 'generating_quizzes'
  const attacking = !answered && b.status === 'active' && g?.phase === 'attack' && g.currentTurnUserId === me
  const myMove = (choosing && !g?.players[me]) || (b.status === 'active' && (pa ? pa.defenderId === me : g?.currentTurnUserId === me))
  const quitting = choosing || b.status === 'active'
  // Ce qu'un abandon ferait maintenant : la confirmation ouverte sur une autre phase se ferme (le focus revient à « Abandonner »).
  const stake = choosing ? 'cancel' : b.status === 'active' ? 'lose' : null
  const sourceOf = (p: PendingAttack): Source | null => {
    const c = g?.players[p.attackerUserId]?.cards.find((x) => x.id === p.attackCardId)
    return c ? { title: c.wikipedia_title, url: c.wikipedia_url } : null
  }
  const nameOf = (u: string) => (u === b.challenger_id ? b.challenger : b.opponent).username
  const turnLine = (t: Turn) => {
    const card = g?.players[t.attackerUserId]?.cards.find((c) => c.id === t.attackCardId)?.wikipedia_title
    const start = `Tour ${formatInt(t.turnNumber)} : ${nameOf(t.attackerUserId)} attaque${card ? ` avec ${card}` : ''}.`
    if (t.allCorrect) return `${start} Aucune erreur : aucun dégât.`
    return `${start} ${formatInt(t.wrong)} ${t.wrong > 1 ? 'mauvaises réponses' : 'mauvaise réponse'} sur ${formatInt(t.total)} : ${formatInt(t.damageDealt)} dégâts.`
  }

  const screen = () => {
    if (answered) {
      return (
        <QuizForm key={answered.question.id} question={answered.question} k={answered.k} n={answered.n} busy={busy} verdict={answered.verdict}
          source={answered.source} onAnswer={() => {}} onContinue={() => {
            refocus.current = { t: 'line', view: screenOf(b, me) }
            setAnswered(null)
          }} />
      )
    }
    switch (b.status) {
      case 'pending':
        return b.opponent_id === me ? (
          <>
            <p data-line="" tabIndex={-1} className={stateLine}>{`${theirs.username} te défie.`}</p>
            {b.expires_at && (
              <p className="flex flex-wrap gap-x-2 text-sm">
                <span className="text-[var(--color-foreground)]/70">Expire dans</span>
                <Countdown endAt={b.expires_at} />
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <button type="button" aria-disabled={busy || undefined} onClick={() => void act('accept', {}, `accept:${id}`, () => 'head')} className={primary}>
                Accepter
              </button>
              <button type="button" aria-disabled={busy || undefined} onClick={() => void act('decline', {}, `decline:${id}`, () => 'head')} className={ghost}>
                Refuser
              </button>
            </div>
          </>
        ) : (
          <>
            <p data-line="" tabIndex={-1} className={stateLine}>{`En attente de la réponse de ${theirs.username}.`}</p>
            <button type="button" aria-disabled={busy || undefined} onClick={() => void act('withdraw_invite', {}, `withdraw_invite:${id}`, () => 'head')}
              className={`${ghost} self-start`}>
              Retirer le défi
            </button>
          </>
        )
      case 'deck_selection':
      case 'generating_quizzes':
        return g?.players[me] ? (
          <p data-line="" tabIndex={-1} className={stateLine}>{`Deck validé. En attente du deck de ${theirs.username}.`}</p>
        ) : (
          <DeckSlots busy={busy} onSubmit={(cards) => void act('submit_deck', { card_ids: cards }, `submit_deck:${id}`,
            (r) => (r.battle.status === 'active' ? 'first' : 'line'))} />
        )
      case 'active': {
        if (!pa) {
          const text = g?.currentTurnUserId === me ? 'À toi d\'attaquer : choisis une carte.' : `${theirs.username} choisit sa carte d'attaque.`
          return <p data-line="" tabIndex={-1} className={stateLine}>{text}</p>
        }
        const q = pa.questions.find((x) => !pa.answered.includes(x.id))
        if (pa.defenderId !== me || !q) {
          const text = `${theirs.username} répond aux questions : ${formatInt(pa.answered.length)} / ${formatInt(pa.questions.length)}`
          return <p data-line="" tabIndex={-1} className={stateLine}>{text}</p>
        }
        const [k, n, source] = [pa.answered.length + 1, pa.questions.length, sourceOf(pa)]
        return <QuizForm key={q.id} question={q} k={k} n={n} busy={busy} verdict={null} source={source}
          onAnswer={(choice) => answer(q, choice, k, n, source)} onContinue={() => {}} />
      }
      case 'completed':
        return (
          <>
            <h2 data-line="" data-first="" tabIndex={-1} className={`text-2xl font-bold outline-none ${b.winner_id === me ? 'text-green-400' : 'text-red-400'}`}>
              {b.winner_id === me ? 'Victoire !' : 'Défaite'}
            </h2>
            {reward !== null && <p className="font-semibold">{`+${formatInt(reward)} ${wikibidous(reward)}`}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/battle" className={link}>Retour aux batailles</Link>
              <Link href="/battle" className={primary}>Nouveau défi</Link>
            </div>
          </>
        )
      case 'cancelled':
        return <p data-line="" tabIndex={-1} className={stateLine}>Bataille annulée</p>
    }
  }

  const panel = (u: { id: string; username: string }) => {
    const p = g?.players[u.id]
    if (!p) return null
    const name = `${uid}-${u.id}`
    return (
      <section key={u.id} aria-labelledby={name} className="card-frame space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p id={name} className="font-semibold wrap-anywhere">{u.username}</p>
          <p className="text-sm tabular-nums">{`PV ${formatInt(p.currentHp)} / ${formatInt(p.maxHp)}`}</p>
        </div>
        <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-light)]">
          <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${p.maxHp ? (100 * p.currentHp) / p.maxHp : 0}%` }} />
        </div>
        <ul className="flex flex-wrap justify-center gap-3">
          {p.cards.map((c) => {
            const used = p.usedCardIds.includes(c.id)
            const desc = `${name}-${c.id}`
            return (
              <li key={c.id} className="flex flex-col items-center gap-2">
                <Card card={toFace(c)} size="grid" />
                {used ? (
                  <p className={hint}>Déjà utilisée</p>
                ) : u.id === me && attacking && (
                  <>
                    <span id={desc} className="sr-only">{c.wikipedia_title}</span>
                    {/* data-first : le premier « Attaquer » est le premier contrôle utile de l'écran. */}
                    <button type="button" data-first="" aria-describedby={desc} aria-disabled={busy || undefined} onClick={() => attack(c.id)} className={primary}>
                      Attaquer
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    )
  }

  return (
    <div ref={root} data-ready="" className="space-y-6">
      <PageHeader title={entry.title} icon={entry.icon}>
        <Link href="/battle" className={link}>Retour aux batailles</Link>
      </PageHeader>
      <h2 ref={head} tabIndex={-1} className="text-lg font-bold outline-none wrap-anywhere">{`${mine.username} contre ${theirs.username}`}</h2>
      <div className="card-frame flex flex-col gap-4 p-4 md:p-6">
        {/* Un écran changé est remonté : son contrôle focalisé disparaît, et le focus suit (effet plus haut), même à balise égale. */}
        <Fragment key={view}>{screen()}</Fragment>
        {error && error.at === view && <p role="alert" className="text-sm font-medium text-red-400">{error.text}</p>}
        {myMove && b.idle_at && (
          <p className={hint}>
            {`Sans action de ta part avant le ${formatDateTime(b.idle_at)}, ${choosing ? 'la bataille sera annulée' : 'tu perds la partie'}.`}
          </p>
        )}
        {quitting && (
          <button type="button" aria-haspopup="dialog" aria-disabled={busy || undefined} onClick={() => { if (!busy) setConfirm(stake) }}
            className={`${ghost} self-start`}>
            Abandonner
          </button>
        )}
      </div>
      {g && (
        <div className="grid gap-4 lg:grid-cols-2">
          {panel(mine)}
          {panel(theirs)}
        </div>
      )}
      {g && (b.status === 'active' || b.status === 'completed') && (
        <div role="log" aria-label="Déroulé de la bataille" className={g.turnHistory.length ? 'card-frame p-4' : undefined}>
          <ol className="space-y-1 text-sm">
            {g.turnHistory.map((t) => <li key={t.turnNumber}>{turnLine(t)}</li>)}
          </ol>
        </div>
      )}
      {confirm && confirm === stake && (
        <Modal onClose={() => setConfirm(null)} labelledBy={`${uid}-quit`} className="card-frame w-full max-w-md space-y-4 p-6 animate-fade-in-up">
          <h2 id={`${uid}-quit`} className="text-xl font-bold">Abandonner la bataille ?</h2>
          <p>{confirm === 'cancel' ? 'La bataille sera annulée.' : 'Tu perdras la partie.'}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) forfeit() }} className={danger}>Abandonner</button>
            <button type="button" onClick={() => setConfirm(null)} className={ghost}>Annuler</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
