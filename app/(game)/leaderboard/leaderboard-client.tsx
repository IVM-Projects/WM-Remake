'use client'

import Link from 'next/link'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { GuildBoard } from '@/components/guild/GuildBoard'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { Avatar } from '@/components/ui/Avatar'
import { link } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { ReadError } from '@/components/ui/Section'
import { tabKey } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/leaderboard')
const TABS = ['players', 'guilds'] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = { players: 'Joueurs', guilds: 'Guildes' }
const BOARDS = [['battles', 'Victoires', 'Victoires'], ['collection', 'Collection', 'Cartes'], ['legendary', 'Légendaires', 'Légendaires']] as const
const PERIODS = [['week', 'Cette semaine'], ['all', 'Depuis toujours']] as const
type Board = (typeof BOARDS)[number][0]
type Period = (typeof PERIODS)[number][0]

type Row = { rank: number; user_id: string; username: string; avatar_url: string | null; value: number }
type PlayerData = { entries: Row[]; me: { rank: number; value: number } | null }
const readable = (r: PlayerData | null): PlayerData | null => (Array.isArray(r?.entries) && r && 'me' in r ? r : null)

const toggle = (on: boolean) => `inline-flex min-h-11 items-center rounded-xl border px-4 text-sm font-medium transition-colors ${on
  ? 'border-[var(--color-accent)] bg-[var(--color-surface-light)] text-[var(--color-accent)]'
  : 'border-[var(--color-foreground)]/40 hover:bg-[var(--color-surface-light)]'}`

// /leaderboard : joueurs (critère × période, relus à chaque critère ; `me` est exact, les entrées peuvent être en cache) et guildes.
// Aucun poll. La réponse d'un critère quitté est jetée (génération).
export function LeaderboardClient() {
  const id = useId()
  const [tab, setTab] = useState<Tab>('players')
  const [board, setBoard] = useState<Board>('battles')
  const [period, setPeriod] = useState<Period>('week')
  const [data, setData] = useState<PlayerData | null>(null)
  const [failed, setFailed] = useState(false)
  const [meId, setMeId] = useState<string | null>(null)
  const gen = useRef(0)
  const pending = useRef(false)
  const h1 = useRef<HTMLHeadingElement>(null)
  const caption = useRef<HTMLTableCaptionElement>(null)
  const root = useRef<HTMLDivElement>(null)

  const read = (b: Board, p: Period) => {
    const g = ++gen.current
    return api<PlayerData | null>(`/api/leaderboard?board=${b}&period=${p}`).then(readable, () => null).then((r) => {
      if (g !== gen.current) return
      setData(r)
      setFailed(!r)
    })
  }
  const onRead = useEffectEvent(() => {
    void read(board, period)
    void createBrowserSupabase().auth.getSession().then(({ data: s }) => setMeId(s.session?.user.id ?? null), () => setMeId(null))
  })
  useEffect(() => { if (tab === 'players') onRead() }, [tab, board, period])

  useEffect(() => {
    if (!pending.current || (!data && !failed)) return
    pending.current = false
    ;(caption.current ?? h1.current)?.focus()
  }, [data, failed])

  const choose = (b: Board, p: Period) => {
    setBoard(b)
    setPeriod(p)
    setData(null)
    setFailed(false)
  }
  const focusTab = () => root.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus()
  const boardLabel = BOARDS.find((x) => x[0] === board)!
  const periodLabel = PERIODS.find((x) => x[0] === period)![1]

  return (
    <div ref={root} data-ready={tab === 'guilds' || data || failed ? '' : undefined} className="space-y-6">
      <PageHeader ref={h1} title={entry.title} icon={entry.icon} />
      <div className="space-y-3">
        <div role="tablist" aria-label="Vues du classement" className="flex flex-nowrap gap-x-1 overflow-x-auto border-b border-[var(--color-border)]">
          {TABS.map((t) => (
            <button
              key={t}
              id={`${id}-tab-${t}`}
              type="button"
              role="tab"
              aria-selected={tab === t}
              aria-controls={`${id}-panel`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => tabKey(e, TABS, tab, id, setTab)}
              className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-4 text-sm font-semibold transition-colors focus-visible:-outline-offset-2 ${tab === t ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-b-2 border-transparent text-[var(--color-foreground)]/70 hover:text-[var(--color-foreground)]'}`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="space-y-3">
          {tab === 'guilds' ? <GuildBoard onTab={focusTab} /> : (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <div role="group" aria-label="Classer par" className="flex flex-wrap gap-2">
                  {BOARDS.map(([b, label]) => (
                    <button key={b} type="button" aria-pressed={board === b} onClick={() => choose(b, period)} className={toggle(board === b)}>{label}</button>
                  ))}
                </div>
                <div role="group" aria-label="Période" className="flex flex-wrap gap-2">
                  {PERIODS.map(([p, label]) => (
                    <button key={p} type="button" aria-pressed={period === p} onClick={() => choose(board, p)} className={toggle(period === p)}>{label}</button>
                  ))}
                </div>
              </div>
              {!data ? (
                failed ? (
                  <ReadError onRetry={() => { pending.current = true; setFailed(false); void read(board, period) }}>
                    Le classement n&apos;a pas pu être chargé.
                  </ReadError>
                ) : <Loading label="Chargement du classement" />
              ) : (
                <>
                  <p className="text-sm font-semibold">
                    {data.me ? `Ton rang : ${formatInt(data.me.rank)} (${formatInt(data.me.value)})` : 'Tu n\'es pas encore classé.'}
                  </p>
                  {data.entries.length ? (
                    <div className="card-frame">
                      <table className="w-full table-fixed text-left text-sm">
                        <caption ref={caption} tabIndex={-1} className="sr-only">{`Classement des joueurs : ${boardLabel[1]}, ${periodLabel}`}</caption>
                        <thead>
                          <tr className="border-b border-[var(--color-border)]">
                            <th scope="col" className="w-14 px-2 py-2 sm:w-16 sm:px-3">Rang</th>
                            <th scope="col" className="px-2 py-2 sm:px-3">Joueur</th>
                            <th scope="col" className="w-28 px-2 py-2 text-right sm:px-3">{boardLabel[2]}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--color-border)]">
                          {data.entries.map((e) => {
                            const own = e.user_id === meId
                            return (
                              <tr key={e.user_id} aria-current={own ? 'true' : undefined} className={own ? 'bg-[var(--color-surface-light)] font-semibold' : undefined}>
                                <td className="px-2 py-2 tabular-nums sm:px-3">{formatInt(e.rank)}</td>
                                <td className="px-2 py-2 sm:px-3">
                                  <span className="flex items-center gap-3">
                                    <span className="hidden sm:inline-flex"><Avatar url={e.avatar_url} name={e.username} size="sm" /></span>
                                    <Link href={`/profile/${encodeURIComponent(e.username)}`} className={`${link} min-w-0 wrap-anywhere`}>{e.username}</Link>
                                    {own && <span className="sr-only"> (toi)</span>}
                                  </span>
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums sm:px-3">{formatInt(e.value)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="card-frame p-6 text-center text-sm">Personne n&apos;est encore classé.</p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
