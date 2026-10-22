'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useEffectEvent, useId, useRef, useState, type KeyboardEvent } from 'react'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { TradeCard } from '@/components/trades/TradeCard'
import type { Trade } from '@/components/trades/types'
import { ghost } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { api } from '@/lib/api'
import { usePoll } from '@/lib/poll'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/trades')
const TABS = ['received', 'sent', 'history'] as const
type Tab = (typeof TABS)[number]
const LABELS: Record<Tab, string> = { received: 'Reçues', sent: 'Envoyées', history: 'Historique' }
// États vides (P19).
const EMPTY: Record<Tab, string> = {
  received: 'Aucune offre reçue en attente.',
  sent: 'Aucune offre envoyée en attente.',
  history: 'Aucun échange terminé.',
}
// Offres d'un panneau : le bouton de chaque div.card-frame.p-4 (R§6.8).
const OFFER = ':scope > .card-frame > button'

// Onglets d'après le joueur de la session du navigateur (P16). Un pending échu arrive en expired (P3) : il passe sous « Historique », qui
// garde l'ordre de la réponse.
const split = (me: string, trades: Trade[]): Record<Tab, Trade[]> => ({
  received: trades.filter((t) => t.status === 'pending' && t.recipient_id === me),
  sent: trades.filter((t) => t.status === 'pending' && t.initiator_id === me),
  history: trades.filter((t) => t.status !== 'pending'),
})

// /trades (M4-15) : onglets du contrat (R§6.8), le seul panneau de l'onglet actif monté. Aucun id fixe : ceux de useId() seulement.
// shortcut: onglet en mémoire et non dans l'adresse (comme /marketplace) ; le passer en ?tab si on le demande.
export function TradesClient() {
  const id = useId()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('received')
  const [data, setData] = useState<{ me: string; trades: Trade[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  // Rang de l'offre focalisée quand une lecture s'applique (ou 0 après « Réessayer ») : si elle disparaît sous le focus, l'offre qui prend
  // sa place, la dernière au-delà, ou l'état vide de l'onglet.
  const refocus = useRef<number | null>(null)

  // Lue à chaque affichage (Activity compris), puis toutes les 20 s onglet visible (M4-15). Une relecture en échec garde la liste d'avant :
  // l'erreur ne s'affiche que sans liste.
  const read = () =>
    Promise.all([api<{ trades: Trade[] }>('/api/trades'), createBrowserSupabase().auth.getSession()]).then(
      ([r, { data: auth }]) => auth.session && { me: auth.session.user.id, trades: r.trades },
      () => null,
    ).then((next) => {
      const i = [...(panel.current?.querySelectorAll(OFFER) ?? [])].findIndex((b) => b === document.activeElement)
      if (i >= 0) refocus.current = i
      if (next) setData(next)
      setFailed(!next)
    })
  const onShow = useEffectEvent(() => void read())
  useEffect(() => onShow(), [])
  usePoll(read, 20_000)

  // Rien si le joueur a mis le focus ailleurs entre-temps : seul un focus tombé sur body bouge.
  useEffect(() => {
    const i = refocus.current
    if (i === null || (!data && !failed)) return
    refocus.current = null
    if (document.activeElement !== document.body) return
    if (!data) return retryButton.current?.focus()
    const offers = panel.current?.querySelectorAll<HTMLElement>(OFFER)
    ;(offers?.[Math.min(i, offers.length - 1)] ?? panel.current?.querySelector<HTMLElement>('[tabindex="-1"]'))?.focus()
  }, [data, failed])

  // Clavier de market-client.tsx : flèches (en boucle), Début et Fin ; l'onglet suit le focus.
  const tabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab)
    const j = ({ ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[e.key]
    if (j === undefined) return
    e.preventDefault()
    const next = TABS[(j + TABS.length) % TABS.length]
    setTab(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }

  // « Réessayer » disparaît pendant la relecture : le focus va ensuite à la première offre, à l'état vide, ou au bouton revenu.
  function retry() {
    refocus.current = 0
    setFailed(false)
    void read()
  }

  const rows = data && split(data.me, data.trades)[tab]
  return (
    <div data-ready={data || failed ? '' : undefined} className="space-y-6">
      <PageHeader title={entry.title} icon={entry.icon} />
      {!rows ? (
        failed ? (
          <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
            <p role="alert" className="text-sm">Impossible de charger cette page.</p>
            <button ref={retryButton} type="button" onClick={retry} className={`${ghost} justify-center`}>
              Réessayer
            </button>
          </div>
        ) : (
          <Loading label="Chargement des échanges" />
        )
      ) : (
        <>
          {/* Une ligne, défilée dans son propre conteneur sur téléphone (jamais la page) ; anneau de focus intérieur : overflow le couperait. */}
          <div role="tablist" aria-label="Vues des échanges" className="flex flex-nowrap gap-x-1 overflow-x-auto border-b border-[var(--color-border)]">
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
                onKeyDown={tabKey}
                className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-4 text-sm font-semibold transition-colors focus-visible:-outline-offset-2 ${tab === t ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-b-2 border-transparent text-[var(--color-foreground)]/70 hover:text-[var(--color-foreground)]'}`}
              >
                {LABELS[t]}
              </button>
            ))}
          </div>
          <div ref={panel} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="space-y-3">
            {rows.length ? (
              rows.map((t) => <TradeCard key={t.id} trade={t} onOpen={() => router.push(`/trades/${t.id}`)} />)
            ) : (
              <p tabIndex={-1} className="card-frame p-6 text-center text-sm outline-none">{EMPTY[tab]}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
