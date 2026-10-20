'use client'

import { useEffect, useRef, useState } from 'react'
import { Turnstile } from '@/components/auth/Turnstile'
import { PackOpening, type CardInPack } from '@/components/packs/PackOpening'
import { PackStock } from '@/components/packs/PackStock'
import { ProDailyBlock } from '@/components/packs/ProDailyBlock'
import { api, ApiError, calendarTz } from '@/lib/api'
import { usePrefs } from '@/lib/prefs'
import { playRip } from '@/lib/sounds'
import { createBrowserSupabase } from '@/lib/supabase/browser'

// period : écart entre deux paquets (next − last), plafond de l'affichage du compte à rebours.
type Stock = { remaining: number; cap: number; nextAt: number | null; period: number | null }
type SyncRow = { pack_cap: number; packs_remaining: number; packs_last_regen_at: string | null; next_regen_at: string | null }
type PackResponse = { cards: CardInPack[]; packs_remaining?: number; packs_last_regen_at?: string | null; next_regen_at?: string | null }
type ErrorBody = { code?: string; packs_remaining?: number; next_regen_at?: string | null } | null

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null)
const timing = (last: string | null | undefined, next: string | null | undefined) => {
  const [l, n] = [at(last), at(next)]
  return { nextAt: n, period: l !== null && n !== null ? n - l : null }
}
const RESYNC_MS = 5_000

// Comme l'original, chaque visite appelle sync_profile_packs : le serveur régénère le stock à la lecture (R§3.1). null = illisible.
async function readStock(): Promise<Stock | null> {
  try {
    const sb = createBrowserSupabase()
    const { data: auth } = await sb.auth.getSession()
    const uid = auth.session?.user.id
    if (!uid) return null
    const { data, error } = await sb.rpc('sync_profile_packs', { user_id: uid })
    const row = (Array.isArray(data) ? data[0] : data) as SyncRow | null | undefined
    return error || !row ? null : { remaining: row.packs_remaining, cap: row.pack_cap, ...timing(row.packs_last_regen_at, row.next_regen_at) }
  } catch {
    return null
  }
}

export function PullsClient() {
  // Charge les préférences dès le repos : playRip() les lit avant que la première carte ne s'affiche.
  usePrefs()
  const [stock, setStock] = useState<Stock | null>(null)
  const [failed, setFailed] = useState(false)
  const [cards, setCards] = useState<CardInPack[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Chemin à relancer une fois la vérification anti-bot passée.
  const [verify, setVerify] = useState<string | null>(null)
  const inflight = useRef(false)
  const lastSync = useRef(0)
  const openBtn = useRef<HTMLButtonElement>(null)
  const idle = useRef<HTMLDivElement>(null)

  const apply = (s: Stock | null) => {
    setFailed(!s)
    if (s) setStock(s)
  }
  const sync = () => {
    lastSync.current = Date.now()
    void readStock().then(apply)
  }

  // Aussi au retour sur la page gardée cachée par Activity : ses effets reprennent, le stock est relu.
  useEffect(() => {
    let live = true
    lastSync.current = Date.now()
    void readStock().then((s) => { if (live) apply(s) })
    return () => { live = false }
  }, [])

  // Ouverture (ou Pro du jour), avec la vérification humaine éventuelle d'abord ; une seule requête à la fois.
  async function claim(path: string, token?: string) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    setVerify(null)
    try {
      if (token) await api('/api/human-check', { method: 'POST', idem: true, body: JSON.stringify({ token }) })
      const res = await api<PackResponse>(path, { method: 'POST', idem: true, headers: calendarTz() })
      const left = res.packs_remaining
      if (left !== undefined) setStock((s) => s && { ...s, remaining: left, ...timing(res.packs_last_regen_at, res.next_regen_at) })
      playRip()
      setCards(res.cards)
    } catch (e) {
      const body = (e instanceof ApiError ? e.body : null) as ErrorBody
      // Une seule relance après la vérification : un second refus s'affiche, sans boucle.
      if (body?.code === 'human_verification_required' && !token) setVerify(path)
      if (body?.packs_remaining === 0) setStock((s) => s && { ...s, remaining: 0, nextAt: at(body.next_regen_at) })
      else setError(e instanceof ApiError ? e.message : 'Le paquet n\'a pas pu être ouvert, réessaie.')
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  function done() {
    setCards(null)
    // Le récapitulatif disparaît avec son bouton : le focus revient sur « Ouvrir », ou sur la zone s'il est désactivé.
    requestAnimationFrame(() => (openBtn.current && !openBtn.current.disabled ? openBtn.current : idle.current)?.focus())
  }

  if (cards) return <PackOpening cards={cards} onDone={done} />

  return (
    <div ref={idle} tabIndex={-1} className="flex flex-col items-center gap-6 outline-none">
      {stock ? (
        <PackStock
          {...stock}
          busy={busy}
          openRef={openBtn}
          onOpen={() => void claim('/api/packs/open')}
          onElapsed={() => { if (Date.now() - lastSync.current > RESYNC_MS) void sync() }}
        />
      ) : failed ? (
        <div className="card-frame flex w-full max-w-sm flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm">Ton stock de paquets n&apos;a pas pu être lu.</p>
          <button
            type="button"
            onClick={() => void sync()}
            className="min-h-11 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]"
          >
            Réessayer
          </button>
        </div>
      ) : (
        <div className="flex min-h-64 flex-1 items-center justify-center" role="status">
          <div className="w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
          <span className="sr-only">Chargement du stock de paquets</span>
        </div>
      )}
      {error && <p role="alert" className="max-w-sm text-center text-sm font-medium text-red-400">{error}</p>}
      {verify && <Turnstile onToken={(t) => { if (t) void claim(verify, t) }} />}
      <ProDailyBlock busy={busy} onClaim={() => void claim('/api/packs/pro-daily')} />
    </div>
  )
}
