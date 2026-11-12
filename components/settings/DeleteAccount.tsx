'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { danger, ghost } from '@/components/ui/button'
import { Modal } from '@/components/ui/Modal'
import { Section } from '@/components/ui/Section'
import { toast } from '@/components/ui/toast'
import { api, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { pushState, unsubscribePush } from '@/lib/push-browser'
import { liveSubscription, type ShopState } from '@/lib/shop'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const CONSEQUENCES = [
  'Tu perds l\'accès au compte, ta collection et tes wikibidous.',
  'Tes ventes en cours, tes mises et tes échanges en attente sont annulés.',
  'Tes batailles commencées sont perdues, celles qui n\'ont pas commencé sont annulées.',
  'Si tu diriges une guilde, son membre le plus ancien devient chef ; si tu en es le seul membre, elle est dissoute.',
  'Tes messages restent visibles chez tes interlocuteurs, sous le nom « Joueur supprimé ».',
  'Télécharge tes données avant, si tu veux les garder.',
]

const STRIPE_CANCEL = 'Ton abonnement Pro sera résilié tout de suite, sans remboursement.'
// Durée du toast et de l'attente avant /login quand la résiliation chez Stripe reste à finir : le message est lisible jusqu'au départ.
const PENDING_MS = 5000
const STRIPE_PENDING = 'La résiliation de ton abonnement sera terminée par l\'équipe.'

// « Supprimer mon compte » (G1) : irréversible, confirmé par la saisie du pseudo (S:81).
export function DeleteAccount({ username }: { username: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Section id="settings-delete" title="Supprimer mon compte">
      <p className="text-sm font-medium">La suppression est immédiate et définitive.</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-foreground)]/70">
        {CONSEQUENCES.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <button type="button" onClick={() => setOpen(true)} className={`${danger} justify-center self-start`}>Supprimer mon compte</button>
      {open && <ConfirmModal username={username} onClose={() => setOpen(false)} />}
    </Section>
  )
}

function ConfirmModal({ username, onClose }: { username: string; onClose: () => void }) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const input = useRef<HTMLInputElement>(null)
  // Abonnement non terminal, lu à l'ouverture : la ligne en plus. Lecture en échec : pas de ligne, le serveur résilie quand même (G10).
  const [subscribed, setSubscribed] = useState(false)
  useEffect(() => {
    let stale = false
    api<ShopState | null>('/api/shop').then((r) => { if (!stale && liveSubscription(r?.me?.subscription)) setSubscribed(true) }, () => {})
    return () => { stale = true }
  }, [])
  const matches = typed.trim().toLowerCase() === username.toLowerCase()

  // Ni Échap, ni voile, ni « Annuler » pendant l'envoi.
  const close = () => { if (!inflight.current) onClose() }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (inflight.current || !matches) return
    inflight.current = true
    setBusy(true)
    setError(null)
    let done: { stripe_pending?: unknown } | null
    try {
      // La clé suit la saisie : une issue incertaine rejoue la même demande.
      done = await apiOnce<{ stripe_pending?: unknown } | null>(keys.current, 'delete-account', '/api/settings/delete-account', { method: 'POST', body: JSON.stringify({ username: typed.trim() }) })
    } catch (err) {
      setError(unsure(err) ? UNSURE : userMessage(err, 'Le compte n\'a pas pu être supprimé.'))
      inflight.current = false
      setBusy(false)
      input.current?.focus()
      return
    }
    // Meilleur effort, comme « Se déconnecter » : rien ne bloque la sortie d'un compte déjà supprimé.
    const { sub } = await pushState().catch(() => ({ sub: null }))
    if (sub?.endpoint) await unsubscribePush().catch(() => null)
    await createBrowserSupabase().auth.signOut({ scope: 'local' }).catch(() => null)
    // La résiliation chez Stripe a échoué : le mot reste lisible avant de quitter la page.
    if (done?.stripe_pending === true) {
      toast(STRIPE_PENDING, PENDING_MS)
      await new Promise((r) => setTimeout(r, PENDING_MS))
    }
    window.location.replace('/login')
  }

  return (
    <Modal onClose={close} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-md animate-fade-in-up space-y-4 p-6 max-h-[90vh] overflow-y-auto">
      <h2 id={`${id}-title`} className="text-xl font-bold">Supprimer ton compte ?</h2>
      {subscribed && <p className="text-sm font-medium">{STRIPE_CANCEL}</p>}
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={`${id}-name`} className="text-sm font-semibold">Tape ton pseudo pour confirmer</label>
          <input
            ref={input}
            id={`${id}-name`}
            value={typed}
            autoComplete="off"
            readOnly={busy}
            onChange={(e) => { setTyped(e.target.value); setError(null) }}
            className="block w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm"
          />
        </div>
        {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="submit" aria-disabled={!matches || busy} className={danger}>Supprimer définitivement</button>
          <button type="button" aria-disabled={busy} onClick={close} className={ghost}>Annuler</button>
        </div>
      </form>
    </Modal>
  )
}
