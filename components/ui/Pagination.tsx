import { formatInt } from '@/lib/format'
import { ghost } from './button'

type Props = { page: number; totalPages: number | null; more?: boolean; onPage: (page: number) => void }

const button = `${ghost} gap-1.5`

// « ← Précédent / Page n / m / Suivant → » (R§2.2) ; `page` en base 0 comme l'API. aria-disabled et non disabled :
// le bouton qu'on vient de presser pour atteindre la dernière page garde le focus.
// totalPages null : total inconnu (recherche du catalogue), « Page n » seul et « Suivant » selon `more` (searchHasMore).
export function Pagination({ page, totalPages, more, onPage }: Props) {
  const first = page <= 0
  const last = totalPages === null ? !more : page >= totalPages - 1
  if (first && last) return null
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-3">
      <button type="button" aria-disabled={first} onClick={() => { if (!first) onPage(page - 1) }} className={button}>
        <span aria-hidden="true">←</span> Précédent
      </button>
      <span className="text-sm tabular-nums">Page {formatInt(page + 1)}{totalPages !== null && ` / ${formatInt(totalPages)}`}</span>
      <button type="button" aria-disabled={last} onClick={() => { if (!last) onPage(page + 1) }} className={button}>
        Suivant <span aria-hidden="true">→</span>
      </button>
    </nav>
  )
}
