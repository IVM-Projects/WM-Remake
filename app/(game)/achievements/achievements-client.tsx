'use client'

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { toast } from '@/components/ui/toast'
import { WCoin } from '@/components/ui/WCoin'
import { api, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatInt, formatShortDate, wikibidous } from '@/lib/format'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/achievements')
const CHECK_EVERY_MS = 5 * 60_000

type Ach = { id: string; title: string; description: string; wikibidous_reward: number; category: string; sort_order: number }
type Mine = Map<string, string | null>
type Alert = { text: string; base: string | null | undefined }

// Instant du dernier check de cet onglet : au niveau du module, il survit à Activity ; un rechargement repart de zéro (le serveur limite aussi à 1 par 5 min).
let lastCheck = 0

const isAch = (r: unknown): r is Ach => !!r && typeof r === 'object' && typeof (r as Ach).id === 'string' && typeof (r as Ach).title === 'string'
  && typeof (r as Ach).category === 'string' && typeof (r as Ach).wikibidous_reward === 'number'

// /achievements : catalogue (data, groupé par catégorie) et succès du joueur lus sous RLS ; check discret, réclamation une fois.
export function AchievementsClient() {
  const id = useId()
  const [list, setList] = useState<Ach[] | null>(null)
  const [mine, setMine] = useState<Mine | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [alerts, setAlerts] = useState<Record<string, Alert>>({})
  const mineRef = useRef<Mine | null>(null)
  const listRef = useRef<Ach[] | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const gen = useRef(0)
  const applied = useRef(0)
  // Cible du focus après le rendu qui suit : le h1 (« Réessayer ») ou la mention « Réclamé le … » d'une ligne.
  const focusTo = useRef<'h1' | { claimed: string } | null>(null)
  const h1 = useRef<HTMLHeadingElement>(null)
  const root = useRef<HTMLDivElement>(null)

  const applyMine = (m: Mine) => {
    mineRef.current = m
    setMine(m)
    // L'alerte d'une ligne tombe quand la ligne change.
    setAlerts((a) => {
      const keep = Object.entries(a).filter(([k, v]) => v.base === undefined || m.get(k) === v.base)
      return keep.length === Object.keys(a).length ? a : Object.fromEntries(keep)
    })
    // Clé de réclamation oubliée quand la ligne relue est réclamée.
    for (const [k, v] of m) if (v) keys.current.delete(`claim:${k}`)
  }
  const readMine = async (): Promise<Mine | null> => {
    const g = ++gen.current
    const sb = createBrowserSupabase()
    const { data: s } = await sb.auth.getSession()
    const me = s.session?.user.id
    if (!me) return null
    const { data, error } = await sb.from('user_achievements').select('achievement_id,claimed_at').eq('user_id', me)
    if (error || !Array.isArray(data)) return null
    // Une lecture partie avant la dernière appliquée est jetée.
    if (g < applied.current) return mineRef.current
    applied.current = g
    const m: Mine = new Map(data.map((r: { achievement_id: string; claimed_at: string | null }) => [r.achievement_id, r.claimed_at]))
    applyMine(m)
    return m
  }
  const readAll = (): Promise<void> => Promise.all([createBrowserSupabase().from('achievements').select('*').order('sort_order'), readMine()]).then(finish)
  const finish = async ([{ data, error }, m]: [{ data: unknown; error: unknown }, Mine | null]) => {
    const rows = !error && Array.isArray(data) && data.every(isAch) ? (data as Ach[]) : null
    if (rows) { listRef.current = rows; setList(rows) }
    if (!rows || !m) { if (!listRef.current || !mineRef.current) setFailed(true); return }
    setFailed(false)
    if (Date.now() - lastCheck < CHECK_EVERY_MS) return
    lastCheck = Date.now()
    // Un échec, 429 compris, n'affiche rien ; jamais de nouvel essai avant 5 min.
    const r = await api<{ unlocked?: number }>('/api/achievements/check', { method: 'POST', body: JSON.stringify({ event: 'achievements_sync' }) }).catch(() => null)
    if (r && typeof r.unlocked === 'number' && r.unlocked > 0) await readMine()
  }
  const onShow = useEffectEvent(() => void readAll())
  useEffect(() => onShow(), [])

  useEffect(() => {
    const t = focusTo.current
    if (!t || document.activeElement !== document.body && document.activeElement !== null) return
    const el = t === 'h1' ? h1.current : root.current?.querySelector<HTMLElement>(`[data-claimed="${t.claimed}"]`)
    if (!el) return
    focusTo.current = null
    el.focus()
  }, [mine, list, failed])

  const retry = () => {
    focusTo.current = 'h1'
    setFailed(false)
    void readAll()
  }

  async function claim(a: Ach) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setAlerts((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== a.id)))
    const refuse = async (text: string) => {
      setAlerts((x) => ({ ...x, [a.id]: { text, base: undefined } }))
      await readMine()
      // L'alerte tombera au prochain changement de la ligne, pas à la relecture qui suit son refus.
      setAlerts((x) => (x[a.id] ? { ...x, [a.id]: { text, base: mineRef.current?.get(a.id) } } : x))
    }
    try {
      const r = await apiOnce<{ ok?: boolean } | null>(keys.current, `claim:${a.id}`, '/api/achievements/claim', {
        method: 'POST', body: JSON.stringify({ achievement_id: a.id }),
      })
      if (!r) return await refuse(UNSURE)
      focusTo.current = { claimed: a.id }
      toast(`${a.title} : +${formatInt(a.wikibidous_reward)} ${wikibidous(a.wikibidous_reward)}`)
      await readMine()
    } catch (e) {
      await refuse(unsure(e) ? UNSURE : userMessage(e, 'L\'action n\'a pas abouti.'))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const ready = (list && mine) || failed
  const unlocked = list && mine ? list.filter((a) => mine.has(a.id)).length : 0
  const toClaim = list && mine ? list.filter((a) => mine.get(a.id) === null).length : 0
  // Catégories dans l'ordre du premier sort_order de chacune (la lecture est déjà triée).
  const groups = new Map<string, Ach[]>()
  for (const a of list ?? []) groups.set(a.category, [...(groups.get(a.category) ?? []), a])

  return (
    <div ref={root} data-ready={ready ? '' : undefined} className="space-y-6">
      <PageHeader ref={h1} title={entry.title} icon={entry.icon} />

      {!list || !mine ? (
        failed ? <LoadError onRetry={retry} /> : <Loading label="Chargement des succès" />
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span>{`${formatInt(unlocked)} / ${formatInt(list.length)} succès débloqués`}</span>
            {toClaim > 0 && <span className="font-semibold text-[var(--color-accent-light)]">{`${formatInt(toClaim)} à réclamer`}</span>}
          </p>
          {[...groups].map(([category, items]) => (
            <section key={category} className="space-y-3">
              <h2 className="text-xl font-bold wrap-anywhere">{category}</h2>
              <ul className="grid gap-3 md:grid-cols-2">
                {items.map((a) => {
                  const state = mine.has(a.id) ? mine.get(a.id) ?? null : undefined
                  const alert = alerts[a.id]
                  return (
                    <li key={a.id} className="card-frame flex flex-col gap-3 p-4">
                      <div className="min-w-0 space-y-1">
                        <h3 id={`${id}-${a.id}`} className="font-semibold wrap-anywhere">{a.title}</h3>
                        <p className="text-sm text-[var(--color-foreground)]/70 wrap-anywhere">{a.description}</p>
                        <p className="inline-flex items-center gap-1.5 text-sm font-medium">
                          <WCoin />
                          <span>{`+${formatInt(a.wikibidous_reward)} ${wikibidous(a.wikibidous_reward)}`}</span>
                        </p>
                      </div>
                      {state === undefined ? (
                        <p className="text-sm text-[var(--color-foreground)]/70">Verrouillé</p>
                      ) : state === null ? (
                        <button type="button" aria-describedby={`${id}-${a.id}`} aria-disabled={busy || undefined} onClick={() => void claim(a)} className={`${primary} self-start`}>
                          Réclamer
                        </button>
                      ) : (
                        <p data-claimed={a.id} tabIndex={-1} className="text-sm font-medium outline-none">{`Réclamé le ${formatShortDate(state)}`}</p>
                      )}
                      {alert && <p role="alert" className="text-sm font-medium text-red-400">{alert.text}</p>}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
