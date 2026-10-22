'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Countdown } from '@/components/market/Countdown'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { TradeSides } from '@/components/trades/TradeCard'
import { STATUS_LABEL, type Trade } from '@/components/trades/types'
import { ghost } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { toast } from '@/components/ui/toast'
import { api, ApiError, apiOnce, calendarTz, unsure, userMessage } from '@/lib/api'
import { usePoll } from '@/lib/poll'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/trades')
const primary = 'inline-flex min-h-11 items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-progress aria-disabled:opacity-80'
const link = 'inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-accent-light)] underline-offset-2 hover:underline'
// Toasts (P19).
const DONE = { accept: 'Échange accepté.', decline: 'Échange refusé.', cancel: 'Échange annulé.' } as const
type Action = keyof typeof DONE

// /trades/[id] (M4-15). Aucun id d'élément : le statut est la cible du focus quand les actions disparaissent.
export function TradeClient() {
  const { id } = useParams<{ id: string }>()
  const [trade, setTrade] = useState<Trade | null>(null)
  // Joueur de la session du navigateur (P16) : undefined tant qu'elle n'est pas lue.
  const [uid, setUid] = useState<string | null>()
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)
  // Une action à la fois : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState(false)
  // Refus de la dernière action (role=alert), gardé jusqu'à la suivante.
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const status = useRef<HTMLParagraphElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const retried = useRef(false)

  const read = () =>
    api<{ trade: Trade }>(`/api/trades/${id}`).then(
      (r) => {
        setTrade(r.trade)
        setFailed(false)
      },
      (e) => {
        // Inconnu ou étranger (404), adresse invalide (400) : « Échange introuvable ». Autre échec : l'échange affiché reste.
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setMissing(true)
        else setFailed(true)
      },
    )
  // Lu à chaque affichage (Activity compris), puis toutes les 20 s tant qu'il est en attente (M4-15).
  const onShow = useEffectEvent(() => void read())
  useEffect(() => onShow(), [])
  useEffect(() => {
    void createBrowserSupabase().auth.getSession().then(({ data }) => setUid(data.session?.user.id ?? null))
  }, [])
  const pending = trade?.status === 'pending'
  usePoll(read, 20_000, pending)

  const recipient = pending && !!uid && trade.recipient_id === uid
  const initiator = pending && !!uid && trade.initiator_id === uid
  // Les actions disparaissent sous le focus (action faite, refus relu, poll) ou « Réessayer » sous le clic : le focus tombé sur body va
  // au statut, ou au « Réessayer » revenu. Rien si le joueur l'a mis ailleurs.
  const had = useRef(false)
  useEffect(() => {
    const lost = had.current && !(recipient || initiator)
    had.current = recipient || initiator
    if (!trade && !failed) return
    const want = lost || retried.current
    retried.current = false
    if (want && document.activeElement === document.body) (trade ? status : retryButton).current?.focus()
  }, [recipient, initiator, trade, failed])

  async function act(action: Action) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await apiOnce<{ status: string; trade: Trade }>(keys.current, `${action}:${id}`, `/api/trades/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
        headers: calendarTz(),
      })
      setTrade(r.trade)
      toast(DONE[action])
    } catch (e) {
      setError(userMessage(e, 'L\'action n\'a pas abouti.'))
      // Refus : l'échange a changé ailleurs, il est relu. Issue inconnue (5xx, réseau) : la clé reste (apiOnce), la relance rejoue.
      if (!unsure(e)) await read()
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  function retry() {
    retried.current = true
    setFailed(false)
    void read()
  }

  const ready = (trade && uid !== undefined) || failed || missing
  return (
    <div data-ready={ready ? '' : undefined} className="space-y-6">
      {missing ? (
        <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
          <h1 className="text-xl font-bold">Échange introuvable</h1>
          <Link href="/trades" className={link}>Retour aux échanges</Link>
        </div>
      ) : !trade ? (
        failed ? (
          <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
            <p role="alert" className="text-sm">Impossible de charger cette page.</p>
            <button ref={retryButton} type="button" onClick={retry} className={`${ghost} justify-center`}>
              Réessayer
            </button>
          </div>
        ) : (
          <Loading label="Chargement de l'échange" />
        )
      ) : (
        <>
          <PageHeader title="Détail de l'échange" icon={entry.icon} />
          <div className="card-frame space-y-4 p-4">
            <p className="wrap-anywhere">{`De ${trade.initiator.username} à ${trade.recipient.username}`}</p>
            <p ref={status} tabIndex={-1} className={`font-semibold outline-none ${STATUS_LABEL[trade.status].className}`}>
              {STATUS_LABEL[trade.status].text}
            </p>
            <p className="flex flex-wrap gap-x-2 text-sm">
              <span className="text-[var(--color-foreground)]/70">Expire dans</span>
              <Countdown endAt={trade.expires_at} over={trade.status !== 'pending'} />
            </p>
            <TradeSides trade={trade} />
          </div>
          {recipient && (
            <div className="flex flex-wrap gap-3">
              <button type="button" aria-disabled={busy || undefined} onClick={() => void act('accept')} className={primary}>Accepter</button>
              <button type="button" aria-disabled={busy || undefined} onClick={() => void act('decline')} className={ghost}>Refuser</button>
              <Link href={`/trades/new?with=${trade.initiator_id}&parent=${trade.id}`} className={ghost}>Contre-offre</Link>
            </div>
          )}
          {initiator && (
            <button type="button" aria-disabled={busy || undefined} onClick={() => void act('cancel')} className={ghost}>Annuler</button>
          )}
          {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
          {(trade.parent_trade_id || trade.counter_trade_id) && (
            <div className="flex flex-wrap gap-x-6">
              {trade.parent_trade_id && <Link href={`/trades/${trade.parent_trade_id}`} className={link}>Voir l&apos;offre d&apos;origine</Link>}
              {trade.counter_trade_id && <Link href={`/trades/${trade.counter_trade_id}`} className={link}>Voir la contre-offre</Link>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
