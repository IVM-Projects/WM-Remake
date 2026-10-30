'use client'

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Loading } from '@/components/ui/Loading'
import { ReadError } from '@/components/ui/Section'
import { api } from '@/lib/api'
import { formatDateTime, formatInt } from '@/lib/format'
import type { GuildBoardData } from './types'

const MAX_TIMEOUT = 2_147_483_647
const MIN_WAIT = 5_000
const readable = (r: GuildBoardData | null): GuildBoardData | null =>
  (Array.isArray(r?.entries) && typeof r.week_end === 'string' && typeof r.season === 'string' ? r : null)
const hide = 'hidden sm:table-cell'

// Classement des guildes de la semaine (onglet de /guild, puis /leaderboard). Relu après reset_in_ms, au plus une fois par 5 s : à la bascule
// du lundi le serveur peut encore rendre 0 (G11). Un échec garde le classement affiché et réessaie dans 5 s ; sans classement, « Réessayer »
// (onTab : le focus y retourne, quand la page a un onglet).
export function GuildBoard({ onTab }: { onTab?: () => void } = {}) {
  const [data, setData] = useState<GuildBoardData | null>(null)
  const [failed, setFailed] = useState(false)
  // Prochaine relecture ; un objet neuf à chaque lecture finie (même délai : le minuteur repart).
  const [next, setNext] = useState<{ ms: number } | null>(null)
  const shown = useRef(false)
  const gen = useRef(0)
  const pending = useRef(false)

  const read = () => {
    const g = ++gen.current
    return api<GuildBoardData | null>('/api/guilds/leaderboard').then(readable, () => null).then((r) => {
      if (g !== gen.current) return
      if (r) {
        shown.current = true
        setData(r)
      }
      setFailed(!r)
      if (r || shown.current) setNext({ ms: Math.min(Math.max(r?.reset_in_ms ?? 0, MIN_WAIT), MAX_TIMEOUT) })
    })
  }
  const onMount = useEffectEvent(() => void read())
  useEffect(() => onMount(), [])
  const onTimer = useEffectEvent(() => void read())
  useEffect(() => {
    if (!next) return
    const t = setTimeout(onTimer, next.ms)
    return () => clearTimeout(t)
  }, [next])

  useEffect(() => {
    if (!pending.current || (!data && !failed)) return
    pending.current = false
    if (document.activeElement === document.body) onTab?.()
  }, [data, failed, onTab])

  if (!data) {
    return failed ? (
      <ReadError onRetry={() => {
        pending.current = true
        setFailed(false)
        void read()
      }}>
        Le classement n&apos;a pas pu être chargé.
      </ReadError>
    ) : (
      <Loading label="Chargement du classement" />
    )
  }
  const { entries, season, week_end: end, user_guild_id: mine } = data
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-semibold">{`Saison ${season}`}</span>
        <span className="text-[var(--color-foreground)]/70">{`Jusqu'au ${formatDateTime(end)}`}</span>
      </p>
      {entries.length ? (
        <div className="card-frame">
          <table className="w-full table-fixed text-left text-sm">
            <caption className="sr-only">{`Classement des guildes, saison ${season}`}</caption>
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th scope="col" className="w-14 px-2 py-2 sm:w-16 sm:px-3">Rang</th>
                <th scope="col" className="px-2 py-2 sm:px-3">Guilde</th>
                <th scope="col" className={`${hide} px-3 py-2 text-right`}>Membres</th>
                <th scope="col" className={`${hide} px-3 py-2 text-right`}>Batailles</th>
                <th scope="col" className={`${hide} px-3 py-2 text-right`}>Enchères</th>
                <th scope="col" className="w-20 px-2 py-2 text-right sm:px-3">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {entries.map((e) => {
                const own = e.guild_id === mine
                return (
                  <tr key={e.guild_id} aria-current={own ? 'true' : undefined} className={own ? 'bg-[var(--color-surface-light)] font-semibold' : undefined}>
                    <td className="px-2 py-2 tabular-nums sm:px-3">{formatInt(e.rank)}</td>
                    <td className="px-2 py-2 wrap-anywhere sm:px-3">
                      {e.guild_name}
                      {own && <span className="sr-only"> (ta guilde)</span>}
                    </td>
                    <td className={`${hide} px-3 py-2 text-right tabular-nums`}>{formatInt(e.member_count)}</td>
                    <td className={`${hide} px-3 py-2 text-right tabular-nums`}>{formatInt(e.score_battles)}</td>
                    <td className={`${hide} px-3 py-2 text-right tabular-nums`}>{formatInt(e.score_wb)}</td>
                    <td className="px-2 py-2 text-right tabular-nums sm:px-3">{formatInt(e.total_score)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="card-frame p-6 text-center text-sm">Aucune guilde classée cette semaine.</p>
      )}
    </div>
  )
}
