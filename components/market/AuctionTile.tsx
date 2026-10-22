import Link from 'next/link'
import { Card } from '@/components/card/Card'
import { WCoin } from '@/components/ui/WCoin'
import { formatInt, wikibidous } from '@/lib/format'
import { Countdown } from './Countdown'
import { auctionFace, type Auction } from './types'

// « Mes enchères » (R§5.5, P21) ; couleurs vérifiées sur le panneau (lib/contrast.test.ts).
const STATE = {
  leading: ['En tête', 'text-[var(--color-accent-light)]'],
  outbid: ['Surenchéri', 'text-red-300'],
  won: ['Gagnée', 'text-[var(--color-accent-light)]'],
  lost: ['Perdue', 'text-[var(--color-foreground)]/70'],
} as const

const row = 'flex items-center justify-between gap-2'
const label = 'text-[var(--color-foreground)]/70'

// Issue d'une vente terminée (« Historique », « Gagnées », P21) ; le détail d'une retirée répond 404 (M3-16), le lien reste celui du contrat.
function outcome(a: Auction): [string, string?] | null {
  if (a.status === 'settled_sold') return [`Vendue pour ${formatInt(a.final_price ?? 0)} ${wikibidous(a.final_price ?? 0)}`]
  if (a.status === 'settled_unsold') return ['Invendue', label]
  return a.status === 'cancelled' ? ['Retirée', label] : null
}

// DOM du contrat (R§6.8, M3-24) : div#marketplace-auction-<id> > a.card-frame.block.p-3, rendu dans la seule liste de l'onglet visible (M3-2).
// Aucun contrôle dans le lien (P30) : ni owned (étoile des favoris), ni onClick sur Card ; *:cursor-pointer! couvre son curseur inline.
export function AuctionTile({ auction: a }: { auction: Auction }) {
  const state = a.my_state && STATE[a.my_state]
  const ended = outcome(a)
  const amount = a.current_bid ?? a.base_amount
  return (
    <div id={`marketplace-auction-${a.id}`}>
      <Link
        href={`/marketplace/${a.id}`}
        className="card-frame block p-3 transition-colors hover:bg-[var(--color-surface-light)] *:cursor-pointer!"
      >
        <Card size="grid" card={auctionFace(a)} isShiny={a.is_shiny} />
        {/* w-0 min-w-full : la largeur de la tuile est celle de la carte, un long pseudo est tronqué au lieu de l'élargir. */}
        <div className="mt-3 w-0 min-w-full space-y-1 text-sm">
          {(a.owned || state || ended) && (
            <div className="flex flex-wrap gap-x-2 text-xs font-semibold">
              {a.owned && <p className="text-[var(--color-accent-light)]">Possédée</p>}
              {state && <p className={state[1]}>{state[0]}</p>}
              {ended && <p className={ended[1]}>{ended[0]}</p>}
            </div>
          )}
          <p className={row}>
            <span className={label}>{a.current_bid === null ? 'Mise de départ' : 'Mise actuelle'}</span>
            <span className="inline-flex items-center gap-1 font-semibold tabular-nums">
              {formatInt(amount)}
              <span className="sr-only"> {wikibidous(amount)}</span>
              <WCoin />
            </span>
          </p>
          <p className={row}>
            <span className={label}>Durée</span>
            <Countdown endAt={a.end_at} over={a.status !== 'active'} />
          </p>
          <p className="truncate">{`Vendu par ${a.seller.username}`}</p>
        </div>
      </Link>
    </div>
  )
}
