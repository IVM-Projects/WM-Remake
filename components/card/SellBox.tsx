'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Turnstile } from '@/components/auth/Turnstile'
import type { Summary } from '@/components/market/MarketPanel'
import { toast } from '@/components/ui/toast'
import { api, ApiError, apiOnce, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { rarityOf } from '@/lib/rarity'
import { faceOf, type OwnedItem } from './CardModal'

// Durées de wm.config auction_durations (M3-24), en minutes.
const DURATIONS = [[10, '10 min'], [30, '30 min'], [60, '1 h'], [180, '3 h'], [360, '6 h'], [720, '12 h']] as const

// Réponse perdue ou 5xx : la vente a pu partir ; relancée telle quelle, elle garde sa clé et le serveur rejoue sa réponse (apiOnce).
const UNSURE = 'La mise aux enchères n\'a pas été confirmée : la carte est peut-être déjà en vente. Relance-la telle quelle pour le savoir.'

type Sale = { base: number; duration: number }

// Clé par corps entier (le serveur rejoue par joueur et clé sans lire le corps), hors du composant pour survivre à la boîte repliée (P27).
const keys = new Map<string, string>()

// Boîte de vente de la modale (M3-24) : un formulaire, donc Entrée envoie ; vérification anti-bot comme /pulls (pulls-client.tsx:103-142).
export function SellBox({ copy, onListed }: { copy: OwnedItem; onListed: () => void }) {
  const router = useRouter()
  const face = faceOf(copy)
  const label = rarityOf(face.rarity).label
  const [base, setBase] = useState('10')
  const [duration, setDuration] = useState(60)
  const [market, setMarket] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Vente à relancer une fois la vérification anti-bot passée.
  const [verify, setVerify] = useState<Sale | null>(null)
  const inflight = useRef(false)

  // Prix du marché de la rareté figée de la copie (P21).
  useEffect(() => {
    let live = true
    api<{ summary: Summary }>(`/api/marketplace/cards/${copy.card_id}/sales?scope=summary`).then(
      (r) => {
        const s = r.summary[face.rarity]
        if (live) setMarket(`Marché · ${label} : ${s ? `${formatInt(s.average)} wikibidous` : 'aucune vente récente'}`)
      },
      (e) => { if (live) setMarket(userMessage(e, 'Le résumé du marché n\'a pas pu être lu.')) },
    )
    return () => { live = false }
  }, [copy.card_id, face.rarity, label])

  async function send({ base, duration }: Sale, token?: string) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    setVerify(null)
    // Échec de /api/human-check : la vente n'est pas partie.
    let sent = false
    try {
      if (token) await api('/api/human-check', { method: 'POST', idem: true, body: JSON.stringify({ token }) })
      sent = true
      const { id } = await apiOnce<{ id: string }>(keys, `sell:${copy.id}:${base}:${duration}`, '/api/marketplace', {
        method: 'POST',
        body: JSON.stringify({ card_id: copy.id, base_amount: base, duration_minutes: duration }),
      })
      toast(`${face.wikipedia_title} a bien été mise aux enchères pour ${formatInt(base)} wikibidous`)
      onListed()
      router.push(`/marketplace/${id}`)
    } catch (e) {
      const body = (e instanceof ApiError ? e.body : null) as { code?: string } | null
      // Une seule relance après la vérification : un second refus s'affiche, sans boucle.
      if (body?.code === 'human_verification_required' && !token) setVerify({ base, duration })
      setError(userMessage(e, sent && unsure(e) ? UNSURE : 'La carte n\'a pas pu être mise aux enchères.'))
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void send({ base: Number(base), duration })
  }

  return (
    <form onSubmit={submit} className="card-frame space-y-3 p-4">
      <label className="block space-y-1 text-sm font-medium">
        <span>Mise de départ</span>
        {/* La boîte s'ouvre au clic de « Mettre aux enchères » : le focus va à son premier champ. */}
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={2147483647}
          step={1}
          required
          autoFocus
          aria-label="Mise de départ"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          className="block min-h-11 w-32 min-w-0 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm tabular-nums"
        />
      </label>
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Durée</legend>
        <div className="grid grid-cols-3 gap-2">
          {DURATIONS.map(([m, text]) => (
            <button
              key={m}
              type="button"
              aria-pressed={duration === m}
              onClick={() => setDuration(m)}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl px-3 text-sm font-medium transition-colors ${duration === m ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-light)]' : 'border border-[var(--color-foreground)]/40 hover:bg-[var(--color-surface-light)]'}`}
            >
              {text}
            </button>
          ))}
        </div>
      </fieldset>
      {market && <p className="rounded-xl bg-[var(--color-surface-light)] px-3 py-2 text-sm font-medium">{market}</p>}
      {/* aria-disabled et la garde de send() pendant la requête, jamais disabled (le focus tomberait sur body, D§7.0). */}
      <button
        type="submit"
        aria-disabled={busy || undefined}
        className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-[var(--color-accent)] px-5 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-progress aria-disabled:opacity-80"
      >
        Lancer l&apos;enchère
      </button>
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      {verify && <Turnstile onToken={(t) => { if (t) void send(verify, t) }} />}
    </form>
  )
}
