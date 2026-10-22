import { ArrowLeftRight } from 'lucide-react'
import { useId } from 'react'
import { formatInt, formatShortDate, wikibidous } from '@/lib/format'
import { ItemChips } from './ItemChips'
import { STATUS_LABEL, type Trade } from './types'

// Les deux côtés d'un échange, « <pseudo> offre » ⇄ « En échange de » : puces et wikibidous (au-dessus de 0). Des span seulement, la
// carte de la liste les rend dans son bouton ; le détail les reprend.
export function TradeSides({ trade: t }: { trade: Trade }) {
  const side = (who: string, title: string, wb: number) => (
    <span className="flex min-w-0 flex-1 flex-col gap-2">
      <span className="text-xs font-semibold text-[var(--color-foreground)]/70 wrap-anywhere">{title}</span>
      <ItemChips items={t.items.filter((i) => i.offered_by === who)} />
      {wb > 0 && <span className="text-sm font-semibold tabular-nums">{`${formatInt(wb)} ${wikibidous(wb)}`}</span>}
    </span>
  )
  return (
    <span className="flex items-start gap-3">
      {side(t.initiator_id, `${t.initiator.username} offre`, t.initiator_wikibidous)}
      <ArrowLeftRight className="mt-0.5 size-5 shrink-0 text-[var(--color-foreground)]/70" />
      {side(t.recipient_id, 'En échange de', t.recipient_wikibidous)}
    </span>
  )
}

// Offre de /trades (DOM du contrat, R§6.8) : div.card-frame.p-4 > button au nom figé ; aria-describedby distingue les offres entre elles.
export function TradeCard({ trade: t, onOpen }: { trade: Trade; onOpen: () => void }) {
  const id = useId()
  const status = STATUS_LABEL[t.status]
  const date = formatShortDate(t.created_at)
  return (
    <div className="card-frame p-4 transition-colors hover:bg-[var(--color-surface-light)]">
      <button type="button" aria-label="Voir le détail de l'échange" aria-describedby={id} onClick={onOpen} className="flex w-full flex-col gap-3 text-left">
        <span className="flex w-full flex-wrap items-baseline gap-x-2 text-sm">
          <span className="min-w-0 font-semibold wrap-anywhere">{`De ${t.initiator.username}`}</span>
          <span className={status.className}>{`· ${status.text}`}</span>
          <span className="ml-auto text-[var(--color-foreground)]/70">
            <time dateTime={t.created_at}>{date}</time>
          </span>
        </span>
        <TradeSides trade={t} />
        <span id={id} className="sr-only">{`De ${t.initiator.username} · ${status.text} · ${date}`}</span>
      </button>
    </div>
  )
}
