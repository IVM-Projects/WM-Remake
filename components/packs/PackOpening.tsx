'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode, type Ref } from 'react'
import { Card, type CardFace } from '@/components/card/Card'
import { rarityOf, type RarityCode } from '@/lib/rarity'
import { playFlip, playLegendary } from '@/lib/sounds'

// Carte d'un paquet (wm.draw_cards) : rarity, titre et stats sont déjà ceux du snapshot de la copie.
export type CardInPack = CardFace & {
  id: string
  card_id: string
  user_card_id: string
  rarity: RarityCode
  is_shiny: boolean
  is_new: boolean
  wikipedia_url: string
}

const SWIPE_PX = 80 // seuil du balayage (D§8.5)
const TIER: Partial<Record<RarityCode, string>> = { SR: 'sr', UR: 'ur', L: 'l' }

const REDUCE = '(prefers-reduced-motion: reduce)'
function onMotionChange(cb: () => void) {
  const query = matchMedia(REDUCE)
  query.addEventListener('change', cb)
  return () => query.removeEventListener('change', cb)
}
const useReducedMotion = () => useSyncExternalStore(onMotionChange, () => matchMedia(REDUCE).matches, () => false)

const spoken = (c: CardInPack) =>
  `${c.wikipedia_title}, ${rarityOf(c.rarity).label}${c.is_shiny ? ', Brillante' : ''}${c.is_new ? ', Nouvelle' : ''}`

type Props = { cards: CardInPack[]; onDone: () => void }

// Révélation carte par carte (R§2.2, D§8.5), puis récapitulatif. Paquet vide (variante `cards: []` de R§3.1) : rien à révéler, retour au repos.
export function PackOpening(props: Props) {
  return props.cards.length ? <Reveal {...props} /> : <Skip onDone={props.onDone} />
}

function Skip({ onDone }: { onDone: () => void }) {
  const done = useEffectEvent(onDone)
  useEffect(() => done(), [])
  return null
}

// Classes du relevé d'origine : contrat, ne pas renommer.
function Reveal({ cards, onDone }: Props) {
  const reduced = useReducedMotion()
  const recapId = useId()
  const [index, setIndex] = useState(0)
  const [seen, setSeen] = useState(1)
  // La carte affichée vient d'être révélée (et non revue) : seule une révélation joue la cinématique L.
  const [fresh, setFresh] = useState(true)
  const [recap, setRecap] = useState(false)
  const [drag, setDrag] = useState<{ x: number; dx: number } | null>(null)
  // Région aria-live remplie après le montage : une région déjà pleine à son apparition n'est pas annoncée.
  const [announce, setAnnounce] = useState(false)
  const played = useRef(false)
  const lost = useRef<Element | null>(null)
  const prevBtn = useRef<HTMLButtonElement>(null)
  const nextBtn = useRef<HTMLButtonElement>(null)
  const moreBtn = useRef<HTMLButtonElement>(null)
  const recapTitle = useRef<HTMLHeadingElement>(null)
  const card = cards[index]
  const left = cards.length - seen
  const tier = TIER[card.rarity]
  const cinematic = !reduced && fresh && card.rarity === 'L'

  const sound = (c: CardInPack, first: boolean) => (first && c.rarity === 'L' ? playLegendary : playFlip)()

  // n ≤ seen : on revoit une carte, ou on révèle la suivante ; jamais de saut par-dessus une carte cachée.
  function go(n: number) {
    if (n < 0 || n >= cards.length || n > seen || n === index) return
    lost.current = document.activeElement
    setIndex(n)
    setFresh(n === seen)
    if (n === seen) setSeen(n + 1)
    sound(cards[n], n === seen)
  }

  // Bouton désactivé sous le focus (« Carte suivante » au bout, « Carte précédente » au début) : le focus passe au suivant logique.
  useEffect(() => {
    const el = lost.current
    lost.current = null
    if (el instanceof HTMLButtonElement && el.disabled) (el === prevBtn.current ? nextBtn : moreBtn).current?.focus()
  }, [index])

  // Ré-exécuté au retour sur la page gardée par Activity : le son et le focus initiaux, une seule fois.
  const shown = useEffectEvent(() => {
    setAnnounce(true)
    if (played.current) return
    played.current = true
    // Paquet d'une carte : « Carte suivante » est désactivé dès le départ, le focus va sur « Continuer ».
    ;(nextBtn.current?.disabled ? moreBtn : nextBtn).current?.focus()
    sound(cards[0], true)
  })
  useEffect(() => {
    const t = setTimeout(() => shown(), 250)
    return () => clearTimeout(t)
  }, [])

  // ← → partout sur la page, sauf dans un champ ou une modale ouverte par-dessus.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (recap || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    if ((e.target as Element).closest?.('dialog, [role=dialog], input, textarea, select, [contenteditable]')) return
    if (e.key === 'ArrowRight') go(index + 1)
    else if (e.key === 'ArrowLeft') go(index - 1)
    else return
    e.preventDefault()
  })
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])

  useEffect(() => {
    if (recap) recapTitle.current?.focus()
  }, [recap])

  const release = (e: PointerEvent) => {
    if (!drag) return
    const dx = e.clientX - drag.x
    setDrag(null)
    if (dx <= -SWIPE_PX) go(index + 1)
    else if (dx >= SWIPE_PX) go(index - 1)
  }

  if (recap) {
    return (
      <section aria-labelledby={recapId} data-motion={reduced ? 'reduced' : 'full'} className="space-y-6 animate-fade-in-up">
        <h2 id={recapId} ref={recapTitle} tabIndex={-1} className="text-center text-xl font-bold outline-none">
          Récapitulatif
        </h2>
        <ul className="flex flex-wrap justify-center gap-3">
          {cards.map((c, k) => (
            <li key={k} className="flex flex-col items-center gap-2">
              <Card card={c} size="grid" isShiny={c.is_shiny} />
              <Badges card={c} />
            </li>
          ))}
        </ul>
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onDone}
            className="min-h-12 rounded-xl bg-[var(--color-accent)] px-8 py-3 font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)]"
          >
            Retour aux paquets
          </button>
        </div>
      </section>
    )
  }

  return (
    // isolate ici : la lumière des paliers (z-index -1) passe sous tout le contenu de la révélation, compteur et boutons compris.
    <div data-motion={reduced ? 'reduced' : 'full'} className="isolate flex flex-col items-center gap-4">
      <div className="flex min-h-7 items-center gap-3">
        <p className="text-sm font-medium text-[var(--color-foreground)]/70">
          <span>Carte</span> <span className="text-lg font-bold tabular-nums text-[var(--color-accent)]">{index + 1}</span>{' '}
          <span>/ {cards.length}</span>
        </p>
        <Badges card={card} />
      </div>
      {cinematic && <div key={`cinematic-${index}`} data-cinematic="" aria-hidden="true" className="legendary-cinematic" />}
      {/* Gestes sur ce cadre fixe, pas sur la carte : pendant son pivot, la carte vue de profil n'offre aucune prise au pointeur. */}
      <div
        className="relative inline-flex max-w-[min(100vw-2rem,28rem)] justify-center touch-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag({ x: e.clientX, dx: 0 })
        }}
        onPointerMove={(e) => { if (drag) setDrag({ x: drag.x, dx: e.clientX - drag.x }) }}
        onPointerUp={release}
        onPointerCancel={() => setDrag(null)}
      >
        {tier && <div key={`glow-${index}`} aria-hidden="true" className={`reveal-glow reveal-glow-${tier} animate-reveal-glow`} />}
        <div
          key={index}
          className="animate-card-flip relative touch-none cursor-grab active:cursor-grabbing select-none *:cursor-[inherit]!"
          // La L attend l'éclair de la cinématique avant de pivoter.
          style={{
            animationDelay: cinematic ? '0.35s' : undefined,
            translate: drag ? `${drag.dx}px 0` : undefined,
            rotate: drag && !reduced ? `${drag.dx / 30}deg` : undefined,
          }}
        >
          <Card card={card} isShiny={card.is_shiny} />
        </div>
      </div>

      <div className="flex w-full max-w-md items-center justify-center gap-3">
        <RoundButton ref={prevBtn} label="Carte précédente" disabled={index === 0} onClick={() => go(index - 1)}>
          <ChevronLeft className="size-6" />
        </RoundButton>
        <div className="flex min-w-0 flex-wrap justify-center gap-8 px-4 py-4">
          {cards.map((c, k) => (
            <button
              key={k}
              type="button"
              aria-label={`Aller à la carte ${k + 1}`}
              aria-current={k === index ? 'step' : undefined}
              disabled={k >= seen}
              onClick={() => go(k)}
              // Point de 12 px (relevé d'origine), cible de 44 px par ::after (D§8.6).
              className={`relative w-3 h-3 rounded-full transition after:absolute after:-inset-4 ${k === index ? 'bg-[var(--color-accent)] scale-125' : k < seen ? 'bg-[var(--color-foreground)]/40 hover:bg-[var(--color-foreground)]/70' : 'bg-[var(--color-foreground)]/15'}`}
            />
          ))}
        </div>
        <RoundButton ref={nextBtn} label="Carte suivante" disabled={index === cards.length - 1} onClick={() => go(index + 1)}>
          <ChevronRight className="size-6" />
        </RoundButton>
      </div>

      {/* Bloquant tant qu'une carte reste cachée (R§5.1) ; « Continuer » mène au récapitulatif. */}
      <button
        ref={moreBtn}
        type="button"
        disabled={left > 0}
        onClick={() => setRecap(true)}
        className="min-h-12 rounded-xl bg-[var(--color-accent)] px-8 py-3 font-semibold text-[var(--color-accent-foreground)] transition-colors hover:enabled:bg-[var(--color-accent-light)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-light)] disabled:text-[var(--color-foreground)]/60"
      >
        {left > 0 ? `Encore ${left} carte${left > 1 ? 's' : ''}` : 'Continuer'}
      </button>

      <p aria-live="polite" className="sr-only">
        {announce && `Carte ${index + 1} / ${cards.length} : ${spoken(card)}`}
      </p>
    </div>
  )
}

function RoundButton({ ref, label, disabled, onClick, children }: { ref: Ref<HTMLButtonElement>; label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="w-12 h-12 shrink-0 inline-flex items-center justify-center rounded-full border border-[var(--color-foreground)]/40 transition-colors hover:enabled:bg-[var(--color-surface-light)] disabled:opacity-20"
    >
      {children}
    </button>
  )
}

function Badges({ card }: { card: CardInPack }) {
  if (!card.is_new && !card.is_shiny) return null
  return (
    <div className="flex items-center gap-2">
      {card.is_new && (
        <span className="rounded-full bg-[var(--color-accent)]/15 px-2.5 py-0.5 text-xs font-bold text-[var(--color-accent-light)]">Nouvelle</span>
      )}
      {card.is_shiny && (
        <span className="rounded-full bg-amber-300/15 px-2.5 py-0.5 text-xs font-bold text-amber-200">Brillante</span>
      )}
    </div>
  )
}
