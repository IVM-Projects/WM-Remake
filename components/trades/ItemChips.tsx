import { rarityOf } from '@/lib/rarity'
import { chipText, type TradeItem } from './types'

// Une puce span[title] par élément (P15, R§6.8) ; fond inline de la même forme littérale que RarityChips.tsx.
export function ItemChips({ items }: { items: TradeItem[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((i, n) => (
        <span
          // Une unité par élément : la même copie peut revenir, l'ordre de la réponse (P7) est la seule clé stable.
          key={n}
          title={i.card.wikipedia_title}
          style={{ backgroundColor: `var(--color-rarity-${rarityOf(i.snapshot_rarity).css})22` }}
          className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-xs font-medium wrap-anywhere"
        >
          {chipText(i)}
        </span>
      ))}
    </span>
  )
}
