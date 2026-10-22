'use client'

import { useEffect, useState } from 'react'
import { api, userMessage } from '@/lib/api'
import { formatDateTime, formatInt } from '@/lib/format'
import { RARITY, rarityOf, type RarityCode } from '@/lib/rarity'

type Summary = Partial<Record<RarityCode, { average: number; count: number }>>
type Sale = { id: string; rarity: RarityCode; is_shiny: boolean; final_price: number; settled_at: string }

const muted = 'text-sm text-[var(--color-foreground)]/70'

// Analyse du marché d'une carte (M3-19, M3-24) : moyenne des dernières ventes par rareté (pour tous, en cache), puis l'historique Pro,
// ou le message du 403 pro_required. null : lecture en cours (rien d'affiché) ; une chaîne : le message d'échec de cette lecture.
export function MarketPanel({ cardId }: { cardId: string }) {
  const [summary, setSummary] = useState<Summary | string | null>(null)
  const [sales, setSales] = useState<Sale[] | string | null>(null)
  useEffect(() => {
    let live = true
    const path = `/api/marketplace/cards/${cardId}/sales`
    api<{ summary: Summary }>(`${path}?scope=summary`).then(
      (r) => { if (live) setSummary(r.summary) },
      (e) => { if (live) setSummary(userMessage(e, 'Le résumé du marché n\'a pas pu être lu.')) },
    )
    api<{ recent: Sale[] }>(path).then(
      (r) => { if (live) setSales(r.recent) },
      (e) => { if (live) setSales(userMessage(e, 'Les ventes n\'ont pas pu être lues.')) },
    )
    return () => { live = false }
  }, [cardId])

  const lines = summary && typeof summary !== 'string' ? RARITY.filter((r) => summary[r.code]) : []
  return (
    <div className="space-y-4">
      {summary === null ? null : typeof summary === 'string' ? (
        <p className={muted}>{summary}</p>
      ) : lines.length ? (
        <div className="space-y-1 text-sm font-medium">
          {lines.map((r) => {
            const { average, count } = summary[r.code]!
            return <p key={r.code}>{`Marché · ${r.label} : ${formatInt(average)} wikibidous (${formatInt(count)} vente${count > 1 ? 's' : ''})`}</p>
          })}
        </div>
      ) : (
        <p className={muted}>Aucune vente récente.</p>
      )}
      <section className="space-y-2">
        <h3 className="text-xs font-bold tracking-wider text-[var(--color-foreground)]/60">VENTES RÉCENTES</h3>
        {sales === null ? null : typeof sales === 'string' ? (
          <p className={muted}>{sales}</p>
        ) : sales.length ? (
          <ul aria-label="Ventes récentes" className="space-y-1 text-sm">
            {sales.map((s) => (
              <li key={s.id} className="tabular-nums">
                {`${rarityOf(s.rarity).label}${s.is_shiny ? ' · Brillante' : ''} · ${formatInt(s.final_price)} wikibidous · `}
                <time dateTime={s.settled_at}>{formatDateTime(s.settled_at)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className={muted}>Aucune vente récente.</p>
        )}
      </section>
    </div>
  )
}
