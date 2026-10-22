'use client'

import { useRef, useState, type FormEvent } from 'react'
import { Turnstile } from '@/components/auth/Turnstile'
import { toast } from '@/components/ui/toast'
import { api, ApiError, apiOnce, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import type { Auction } from './types'

// Réponse de POST …/bid (M3-15) : la part que l'enchère affichée reprend.
export type BidResult = { current_bid: number; end_at: string; min_next_bid: number }

// Réponse perdue ou 5xx : la mise a pu être placée ; relancée, elle garde sa clé et le serveur rejoue sa réponse (apiOnce).
const UNSURE = 'La mise n\'a pas été confirmée : elle a peut-être été placée. L\'enchère se met à jour.'

// Bloc « Miser » (M3-24) : un formulaire, donc Entrée envoie ; vérification anti-bot comme /pulls (pulls-client.tsx:103-142).
export function BidBox({ auction, onBid }: { auction: Auction; onBid: (r: BidResult) => void }) {
  // null : champ jamais touché, il suit min_next_bid à chaque lecture (polling, réponse de mise).
  const [typed, setTyped] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Montant à relancer une fois la vérification anti-bot passée.
  const [verify, setVerify] = useState<number | null>(null)
  const inflight = useRef(false)
  // Une Idempotency-Key par enchère, gardée tant que l'issue est inconnue ; oubliée sur un 4xx, d'où une relance à clé neuve (P27).
  const keys = useRef(new Map<string, string>())
  const value = typed ?? String(auction.min_next_bid ?? '')

  async function send(amount: number, token?: string) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    setVerify(null)
    try {
      if (token) await api('/api/human-check', { method: 'POST', idem: true, body: JSON.stringify({ token }) })
      const r = await apiOnce<BidResult>(keys.current, auction.id, `/api/marketplace/${auction.id}/bid`, {
        method: 'POST',
        body: JSON.stringify({ amount }),
      })
      toast(`Mise de ${formatInt(r.current_bid)} wikibidous placée.`)
      setTyped(null)
      onBid(r)
    } catch (e) {
      const body = (e instanceof ApiError ? e.body : null) as { code?: string; min?: number } | null
      // Une seule relance après la vérification : un second refus s'affiche, sans boucle.
      if (body?.code === 'human_verification_required' && !token) setVerify(amount)
      if (body?.code === 'bid_too_low' && body.min) setTyped(String(body.min))
      setError(userMessage(e, unsure(e) ? UNSURE : 'La mise n\'a pas pu être placée.'))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void send(Number(value))
  }

  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="flex gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          required
          aria-label="Montant de la mise"
          value={value}
          onChange={(e) => setTyped(e.target.value)}
          className="min-h-11 w-32 min-w-0 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm tabular-nums"
        />
        {/* aria-disabled et la garde de send() pendant la requête, jamais disabled (le focus tomberait sur body, D§7.0). */}
        <button
          type="submit"
          aria-disabled={busy || undefined}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--color-accent)] px-5 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-progress aria-disabled:opacity-80"
        >
          Miser
        </button>
      </form>
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      {verify !== null && <Turnstile onToken={(t) => { if (t) void send(verify, t) }} />}
    </div>
  )
}
