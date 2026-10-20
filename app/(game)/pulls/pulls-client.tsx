'use client'

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Turnstile } from '@/components/auth/Turnstile'
import { PackOpening, type CardInPack } from '@/components/packs/PackOpening'
import { PackStock } from '@/components/packs/PackStock'
import { ProDailyBlock } from '@/components/packs/ProDailyBlock'
import { api, ApiError, apiOnce, calendarTz, unsure, userMessage } from '@/lib/api'
import { usePrefs } from '@/lib/prefs'
import { playRip, unlockAudio } from '@/lib/sounds'
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
const OPEN = '/api/packs/open'
const PRO_DAILY = '/api/packs/pro-daily'
// Réponse perdue ou 5xx : l'action a pu avoir lieu. La relance garde sa clé (apiOnce) et rejoue la même réponse.
const UNSURE: Record<string, string> = {
  [OPEN]: 'L\'ouverture n\'a pas été confirmée : le paquet a peut-être été ouvert, ses cartes sont alors déjà dans ta collection. Ton stock se met à jour.',
  [PRO_DAILY]: 'La récupération n\'a pas été confirmée : le paquet Pro a peut-être été reçu. Réessaie pour le voir, il ne sera pas donné deux fois.',
}

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
  // Chemin de la requête en cours : seul son bouton affiche « Ouverture… ».
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Chemin à relancer une fois la vérification anti-bot passée.
  const [verify, setVerify] = useState<string | null>(null)
  const inflight = useRef(false)
  const lastSync = useRef(0)
  // Génération du stock : une réponse qui porte un stock frais l'incrémente, une relecture partie avant elle arrive périmée et est jetée.
  const gen = useRef(0)
  // Une Idempotency-Key par action (chemin), gardée tant que son issue est inconnue.
  const keys = useRef(new Map<string, string>())
  const openBtn = useRef<HTMLButtonElement>(null)
  const idle = useRef<HTMLDivElement>(null)

  // Stock vide sous le focus : « Ouvrir » va être désactivé (body sinon) ; la zone le reprend tout de suite, avant le rendu.
  // Tout stock reçu passe par là : refus 403, relecture après un échec sans verdict, relecture périodique.
  const keepFocus = (remaining: number) => {
    if (remaining < 1 && document.activeElement === openBtn.current) idle.current?.focus()
  }
  const apply = (s: Stock | null) => {
    setFailed(!s)
    if (!s) return
    keepFocus(s.remaining)
    // Stock vide : « Ouvrir » ne peut plus rejouer l'ouverture incertaine ; la clé gardée rejouerait l'ancien paquet au retour du stock.
    if (s.remaining < 1) keys.current.delete(OPEN)
    setStock(s)
  }
  // Résout à true si un stock lisible a été affiché.
  const read = (keep: () => boolean = () => true) => {
    const g = gen.current
    lastSync.current = Date.now()
    return readStock().then((s) => {
      if (!keep() || g !== gen.current) return false
      apply(s)
      return !!s
    })
  }
  // Cible stable après la disparition d'un bouton (récapitulatif, « Réessayer ») : « Ouvrir », ou la zone s'il est désactivé.
  const focusIdle = () => requestAnimationFrame(() => (openBtn.current && !openBtn.current.disabled ? openBtn.current : idle.current)?.focus())

  // Aussi au retour sur la page gardée cachée par Activity : ses effets reprennent, le stock est relu.
  const readOnShow = useEffectEvent(read)
  useEffect(() => {
    let live = true
    void readOnShow(() => live)
    return () => { live = false }
  }, [])

  // Ouverture (ou Pro du jour), avec la vérification humaine éventuelle d'abord ; une seule requête à la fois.
  async function claim(path: string, token?: string) {
    if (inflight.current) return
    inflight.current = true
    // Avant tout await : iOS Safari ne débloque l'audio que dans le geste lui-même.
    unlockAudio()
    setBusy(path)
    setError(null)
    setVerify(null)
    let sent = false
    try {
      if (token) await api('/api/human-check', { method: 'POST', idem: true, body: JSON.stringify({ token }) })
      sent = true
      const res = await apiOnce<PackResponse>(keys.current, path, path, { method: 'POST', headers: calendarTz() })
      const left = res.packs_remaining
      // Pro du jour : { cards } seulement, aucun stock, donc la relecture en cours (parfois la toute première) reste valable.
      if (left !== undefined) {
        gen.current++
        setFailed(false)
        setStock((s) => s && { ...s, remaining: left, ...timing(res.packs_last_regen_at, res.next_regen_at) })
      }
      playRip()
      setCards(res.cards)
    } catch (e) {
      const body = (e instanceof ApiError ? e.body : null) as ErrorBody
      // Une seule relance après la vérification : un second refus s'affiche, sans boucle.
      if (body?.code === 'human_verification_required' && !token) setVerify(path)
      const maybe = sent && unsure(e)
      if (body?.packs_remaining === 0) {
        gen.current++
        setFailed(false)
        // Dernier paquet ouvert ailleurs ; PackStock annonce le stock vide dans sa région polie.
        keepFocus(0)
        setStock((s) => s && { ...s, remaining: 0, nextAt: at(body.next_regen_at) })
      } else setError(userMessage(e, maybe ? UNSURE[path] : 'Le paquet n\'a pas pu être ouvert, réessaie.'))
      if (maybe) void read()
    } finally {
      inflight.current = false
      setBusy(null)
    }
  }

  function done() {
    setCards(null)
    focusIdle()
  }

  if (cards) return <PackOpening cards={cards} onDone={done} />

  return (
    <div ref={idle} tabIndex={-1} className="flex flex-col items-center gap-6 outline-none">
      {stock && (
        <PackStock
          {...stock}
          busy={busy === OPEN}
          openRef={openBtn}
          onOpen={() => void claim(OPEN)}
          // Après un échec, plus de relecture automatique : « Réessayer » la relance (pas de requête toutes les 5 s pour rien).
          onElapsed={() => { if (!failed && Date.now() - lastSync.current > RESYNC_MS) void read() }}
        />
      )}
      {/* Région polie toujours présente et vide d'abord (un message déjà là à l'insertion n'est souvent pas lu) ; le bouton hors d'elle. */}
      <div className={failed ? 'card-frame flex w-full max-w-sm flex-col items-center gap-3 p-6 text-center' : 'contents'}>
        <p role="status" className={failed ? 'text-sm' : 'sr-only'}>{failed && 'Ton stock de paquets n\'a pas pu être lu.'}</p>
        {failed && (
          <button
            type="button"
            // Réussite : la note et ce bouton disparaissent ; le focus, tombé sur body, va sur « Ouvrir ».
            onClick={() => void read().then((ok) => { if (ok) focusIdle() })}
            className="min-h-11 rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]"
          >
            Réessayer
          </button>
        )}
      </div>
      {!failed && !stock && (
        <div className="flex min-h-64 flex-1 items-center justify-center" role="status">
          <div className="w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
          <span className="sr-only">Chargement du stock de paquets</span>
        </div>
      )}
      {error && <p role="alert" className="max-w-sm text-center text-sm font-medium text-red-400">{error}</p>}
      {verify && <Turnstile onToken={(t) => { if (t) void claim(verify, t) }} />}
      <ProDailyBlock busy={busy === PRO_DAILY} onClaim={() => void claim(PRO_DAILY)} />
    </div>
  )
}
