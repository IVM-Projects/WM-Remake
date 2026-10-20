import { formatInt } from '@/lib/format'

type Props = { page: number; totalPages: number; onPage: (page: number) => void }

const button = 'inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)] aria-disabled:cursor-not-allowed aria-disabled:border-[var(--color-border)] aria-disabled:text-[var(--color-foreground)]/60 aria-disabled:hover:bg-transparent'

// « ← Précédent / Page n / m / Suivant → » (R§2.2) ; `page` en base 0 comme l'API. aria-disabled et non disabled :
// le bouton qu'on vient de presser pour atteindre la dernière page garde le focus.
export function Pagination({ page, totalPages, onPage }: Props) {
  if (totalPages <= 1) return null
  const first = page <= 0
  const last = page >= totalPages - 1
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-3">
      <button type="button" aria-disabled={first} onClick={() => { if (!first) onPage(page - 1) }} className={button}>
        <span aria-hidden="true">←</span> Précédent
      </button>
      <span className="text-sm tabular-nums">Page {formatInt(page + 1)} / {formatInt(totalPages)}</span>
      <button type="button" aria-disabled={last} onClick={() => { if (!last) onPage(page + 1) }} className={button}>
        Suivant <span aria-hidden="true">→</span>
      </button>
    </nav>
  )
}
