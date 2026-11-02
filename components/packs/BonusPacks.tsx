'use client'

import { Gift } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Turnstile } from '@/components/auth/Turnstile'
import type { CardInPack } from '@/components/packs/PackOpening'
import { primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { api, ApiError, apiOnce, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { unlockAudio } from '@/lib/sounds'

type Special = { id: string; name: string; description: string | null; size: number }
type Grace = { available: number; size: number | null }

const GRACE = '/api/packs/grace'
const SPECIAL = '/api/packs/special'
const UNSURE_TEXT = 'La récupération n\'a pas été confirmée : le paquet a peut-être été reçu, ses cartes sont alors déjà dans ta collection. Réessaie pour le voir, il ne sera pas donné deux fois.'
const cartes = (n: number) => `${formatInt(n)} carte${n > 1 ? 's' : ''}`

// Paquets offerts en attente (S:80) : paquets spéciaux actifs et dotations de grâce. Masquée sans rien à récupérer.
// Chaque lecture échoue seule : ce qui a pu être lu reste réclamable.
// onRetried : « Réessayer » a réussi et son bouton a disparu, le parent reprend le focus.
export function BonusPacks({ onCards, onRetried }: { onCards: (cards: CardInPack[]) => void; onRetried: () => void }) {
  const id = useId()
  const [specials, setSpecials] = useState<Special[]>([])
  const [grace, setGrace] = useState<Grace | null>(null)
  const [failed, setFailed] = useState(false)
  // Intention en cours (clé du paquet) : une seule réclamation à la fois, garde synchrone pour le double clic.
  const [busy, setBusy] = useState<string | null>(null)
  const inflight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  // Réclamation à relancer une fois la vérification anti-bot passée.
  const [verify, setVerify] = useState<{ intent: string; path: string; body?: string } | null>(null)
  const keys = useRef(new Map<string, string>())
  const live = useRef(true)

  const read = useCallback(async () => {
    const [s, g] = await Promise.all([
      api<{ packs?: Special[] } | null>(SPECIAL).catch(() => null),
      api<Grace | null>(GRACE).catch(() => null),
    ])
    if (!live.current) return false
    const okS = !!s && Array.isArray(s.packs)
    const okG = !!g && typeof g.available === 'number'
    setFailed(!okS || !okG)
    if (okS) setSpecials(s.packs!)
    if (okG) setGrace(g)
    return okS && okG
  }, [])

  // Relue à chaque montage : PullsClient remonte la page au retour d'une révélation.
  useEffect(() => {
    live.current = true
    void read()
    return () => { live.current = false }
  }, [read])

  async function claim(intent: string, path: string, body?: string, token?: string) {
    if (inflight.current) return
    inflight.current = true
    // Avant tout await : iOS Safari ne débloque l'audio que dans le geste lui-même.
    unlockAudio()
    setBusy(intent)
    setError(null)
    setVerify(null)
    let sent = false
    try {
      if (token) await api('/api/human-check', { method: 'POST', idem: true, body: JSON.stringify({ token }) })
      sent = true
      const res = await apiOnce<{ cards: CardInPack[] } | null>(keys.current, intent, path, { method: 'POST', body })
      if (!res || !Array.isArray(res.cards)) throw new Error('réponse illisible')
      void read()
      onCards(res.cards)
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string } | null)?.code : undefined
      if (code === 'human_verification_required' && !token) setVerify({ intent, path, body })
      else setError(userMessage(e, sent && unsure(e) ? UNSURE_TEXT : 'Le paquet n\'a pas pu être récupéré, réessaie.'))
      // Introuvable ou déjà réclamé ailleurs : la liste est périmée.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) void read()
    } finally {
      inflight.current = false
      if (live.current) setBusy(null)
    }
  }

  const hasGrace = !!grace && grace.available > 0 && grace.size !== null
  const hasAny = specials.length > 0 || hasGrace
  const button = (label: string, run: () => void) => (
    <button type="button" aria-label={label} aria-disabled={busy !== null || undefined} onClick={run} className={`${primary} shrink-0`}>
      Récupérer
    </button>
  )

  return (
    <>
      {hasAny && (
        <section aria-labelledby={id} className="card-frame w-full max-w-sm space-y-3 p-4">
          <h2 id={id} className="inline-flex items-center gap-2 text-base font-bold">
            <Gift className="size-4 text-[var(--color-accent)]" />
            Paquets offerts
          </h2>
          <ul className="space-y-3">
            {specials.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold wrap-anywhere">{`${p.name} : ${cartes(p.size)}`}</p>
                  {p.description && <p className="text-sm text-[var(--color-foreground)]/70 wrap-anywhere">{p.description}</p>}
                </div>
                {button(`Récupérer ${p.name}`, () => void claim(p.id, SPECIAL, JSON.stringify({ packId: p.id })))}
              </li>
            ))}
            {hasGrace && (
              <li className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold">{`Paquet offert par l'équipe : ${cartes(grace.size!)}`}</p>
                {button('Récupérer le paquet offert', () => void claim(GRACE, GRACE))}
              </li>
            )}
          </ul>
          <span role="status" className="sr-only">{busy ? 'Récupération du paquet…' : ''}</span>
        </section>
      )}
      {error && <p role="alert" className="max-w-sm text-center text-sm font-medium text-red-400">{error}</p>}
      {verify && <Turnstile onToken={(t) => { if (t) void claim(verify.intent, verify.path, verify.body, t) }} />}
      {failed && <LoadError text="Tes paquets offerts n'ont pas pu être lus." onRetry={() => void read().then((ok) => { if (ok) onRetried() })} />}
    </>
  )
}
