'use client'

import { useEffect, useEffectEvent, useSyncExternalStore, type Ref } from 'react'
import { brand } from '@/lib/brand'
import { serverNow } from '@/lib/clock'
import { formatCountdown } from '@/lib/format'

// Un store plutôt qu'un état : une page réaffichée (Activity) lit l'heure du moment, pas celle de son départ.
// Sondé 4 fois par seconde : un minuteur en retard ne fait jamais sauter ni figer une seconde (rendu seulement quand elle change).
function subscribeClock(cb: () => void) {
  const id = setInterval(cb, 250)
  return () => clearInterval(id)
}

type Props = {
  remaining: number
  cap: number
  nextAt: number | null
  period: number | null
  busy: boolean
  onOpen: () => void
  // Échéance du prochain paquet atteinte : le parent relit le stock.
  onElapsed: () => void
  openRef: Ref<HTMLButtonElement>
}

// État repos de /pulls (R§2.2) : visuel du paquet, « Ouvrir », card-frame « n / 10 », compte à rebours et barre de 10 segments.
export function PackStock({ remaining, cap, nextAt, period, busy, onOpen, onElapsed, openRef }: Props) {
  // Date est tronquée à la seconde : le serveur est en moyenne 500 ms après serverNow(). L'affichage vise ce milieu,
  // la relecture du stock attend la borne basse (lib/clock.ts) : elle ne demande jamais un paquet pas encore régénéré.
  const left = useSyncExternalStore(subscribeClock, () => (nextAt === null ? 0 : Math.ceil((nextAt - serverNow() - 500) / 1000)), () => 0)
  const empty = remaining < 1
  const elapsed = useEffectEvent(onElapsed)
  useEffect(() => {
    if (nextAt !== null && serverNow() >= nextAt) elapsed()
  }, [left, nextAt])

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <PackArt opening={busy} empty={empty} />
      <div className="flex flex-col items-center gap-2">
        {/* Jamais disabled pendant la requête (le focus tomberait sur body) : aria-disabled et la garde du parent. */}
        <button
          ref={openRef}
          type="button"
          disabled={empty}
          aria-disabled={busy || undefined}
          onClick={onOpen}
          // Visible sans mouvement (le tremblement du paquet est coupé en motion-reduce) : libellé et opacité.
          className="min-h-12 min-w-44 rounded-xl bg-[var(--color-accent)] px-8 py-3 text-base font-semibold text-[var(--color-accent-foreground)] transition-colors hover:enabled:bg-[var(--color-accent-light)] aria-disabled:cursor-progress aria-disabled:opacity-80 disabled:cursor-not-allowed disabled:bg-[var(--color-surface-light)] disabled:text-[var(--color-foreground)]/60"
        >
          {busy ? 'Ouverture…' : 'Ouvrir'}
        </button>
        {/* Le libellé d'un bouton déjà focalisé n'est pas toujours relu : l'état passe aussi par une région polie,
            stock vide compris (dernier paquet ouvert dans un autre onglet : la réponse 403 le dit ici). */}
        <p role="status" className={empty && !busy ? 'text-sm font-medium text-[var(--color-foreground)]/80' : 'sr-only'}>
          {busy ? 'Ouverture du paquet…' : empty ? 'Plus de paquets disponibles' : ''}
        </p>
      </div>
      <div className="card-frame w-full max-w-sm space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-2xl font-bold tabular-nums">
            <span className="text-[var(--color-accent)]">{remaining}</span>
            <span className="text-[var(--color-foreground)]/60"> / {cap}</span>
          </p>
          <p className="text-sm text-[var(--color-foreground)]/70">paquets disponibles</p>
        </div>
        {/* Doublon visuel du nombre ci-dessus : caché aux lecteurs d'écran. */}
        <div data-stock-bar="" aria-hidden="true" className="flex gap-1">
          {Array.from({ length: cap }, (_, k) => (
            <span
              key={k}
              className={`h-2 flex-1 rounded-full transition-colors duration-500 ${k < remaining ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-light)]'}`}
            />
          ))}
        </div>
        <p className="text-sm text-[var(--color-foreground)]/70">
          {nextAt === null ? 'Réserve pleine' : (
            <>
              Prochain dans{' '}
              {/* Jamais plus que la période : l'estimation peut retarder d'une seconde (« 10:01 » sinon). */}
              <span className="font-mono font-semibold text-[var(--color-accent)]">{formatCountdown(Math.min(left * 1000, period ?? Infinity))}</span>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

// Notre paquet : feuille nacrée aux teintes des raretés, bande C → L, mot-marque de la marque configurée (jamais l'art d'origine).
function PackArt({ opening, empty }: { opening: boolean; empty: boolean }) {
  return (
    <div aria-hidden="true" className={`relative isolate h-64 w-44 select-none ${empty ? 'opacity-50 grayscale' : ''}`}>
      <div className="pack-halo absolute -inset-10 -z-10" />
      <div
        className={`pack-foil relative flex h-full w-full flex-col overflow-hidden rounded-xl shadow-[0_18px_40px_-12px_rgb(0_0_0/0.7)] ${opening ? 'motion-safe:animate-pack-shake' : 'motion-safe:hover:-rotate-2 motion-safe:hover:scale-[1.03]'}`}
      >
        <div className="pack-crimp h-5 shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-3">
          <span className="pack-band h-1.5 w-28 rounded-full" />
          {/* Taille selon la longueur du nom de marque : il tient toujours sur une ligne, dans les 152 px de la feuille. */}
          <span
            className="text-center leading-none font-extrabold tracking-tight text-black"
            style={{ fontFamily: 'var(--font-heading)', fontSize: `min(2.25rem, ${17 / brand.name.length}rem)` }}
          >
            {brand.prefix && <span className="text-[var(--color-accent-foreground)]">{brand.prefix}</span>}
            {brand.rest}
          </span>
          <span className="pack-band h-1.5 w-28 rounded-full" />
          <span className="text-[10px] font-bold tracking-[0.3em] text-black/70">5 CARTES</span>
        </div>
        <div className="pack-crimp h-5 shrink-0" />
      </div>
    </div>
  )
}
