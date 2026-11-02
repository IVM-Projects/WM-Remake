'use client'

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useShop } from '@/components/shop/ShopProvider'
import { ghost, primary } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { ReadError, Section } from '@/components/ui/Section'
import { api, userMessage } from '@/lib/api'
import { liveSubscription, PORTAL_FAILED, stripeUrl, type ShopState } from '@/lib/shop'

type Me = ShopState['me']

const PAST_DUE = 'Le dernier paiement a échoué : ton abonnement Pro est suspendu. Mets à jour ton moyen de paiement.'

// 2xx sans `me` lisible : une lecture en échec.
const readMe = (r: ShopState | null): Me | null => {
  const me = r?.me
  const sub = me?.subscription
  return me && typeof me.has_customer === 'boolean' && typeof me.is_vip === 'boolean' && (sub == null || typeof sub.status === 'string') ? me : null
}
const dateFr = (iso: string | null | undefined): string | null => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : null
}

// Phrase d'état (G4, G20) : l'abonnement d'abord, les avantages de l'équipe ensuite.
export function statusText(me: Me): string {
  const s = me.subscription
  if (!s || !liveSubscription(s)) return me.is_vip ? 'Avantages Pro accordés par l\'équipe.' : 'Tu n\'as pas d\'abonnement.'
  if (s.status === 'past_due' || s.status === 'unpaid') return PAST_DUE
  if (s.status !== 'active' && s.status !== 'trialing') return 'Ton abonnement Pro n\'est pas actif pour l\'instant.'
  const end = dateFr(s.current_period_end)
  if (s.cancel_at_period_end) return `Abonnement Pro résilié : tu restes Pro ${end ? `jusqu'au ${end}` : 'jusqu\'à la fin de la période'}.`
  return `Abonnement Pro actif.${end ? ` Prochain renouvellement le ${end}.` : ''}`
}

// « Abonnement » de /settings : statut lu de /api/shop (lecture propre à la section, relue au retour du Portail), Portail de Stripe (G21).
export function Subscription() {
  const { openShop } = useShop()
  // null : en lecture ; false : lecture en échec.
  const [me, setMe] = useState<Me | null | false>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Garde synchrone : deux clics dans le même tour de rendu ne partent pas deux fois.
  const sending = useRef(false)
  // Une réponse partie avant une lecture plus récente est périmée.
  const gen = useRef(0)

  // quiet : relecture en arrière-plan, un échec garde l'affichage.
  const read = (quiet: boolean) => {
    const g = ++gen.current
    api<ShopState | null>('/api/shop').then(readMe, () => null).then((m) => {
      if (g !== gen.current) return
      if (m) setMe(m)
      else if (!quiet) setMe(false)
    })
  }
  // À chaque affichage (Activity compris), au retour au premier plan et au retour par l'historique depuis le Portail (page restaurée).
  const onShow = useEffectEvent((quiet: boolean) => read(quiet))
  useEffect(() => {
    onShow(false)
    const visible = () => { if (document.visibilityState === 'visible') onShow(true) }
    const back = (e: PageTransitionEvent) => {
      if (!e.persisted) return
      sending.current = false
      setBusy(false)
      onShow(true)
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('pageshow', back)
    return () => {
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('pageshow', back)
    }
  }, [])

  // « Réessayer » disparaît avec l'erreur : le focus attend sur le titre.
  const retry = () => {
    document.getElementById('settings-subscription')?.focus()
    setMe(null)
    read(false)
  }

  async function portal() {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      const url = stripeUrl(await api<{ url?: unknown } | null>('/api/stripe/portal', { method: 'POST' }))
      if (!url) throw new Error('url')
      window.location.assign(url)
    } catch (e) {
      sending.current = false
      setBusy(false)
      setError(userMessage(e, PORTAL_FAILED))
    }
  }

  return (
    <Section id="settings-subscription" title="Abonnement" ready={me !== null}>
      {me === null ? (
        <Loading label="Chargement de l'abonnement" />
      ) : me === false ? (
        <ReadError onRetry={retry}>Ton abonnement n&apos;a pas pu être chargé.</ReadError>
      ) : (
        <>
          <p className="text-sm font-medium">{statusText(me)}</p>
          {!liveSubscription(me.subscription) && !me.is_vip && (
            <button type="button" onClick={openShop} className={`${primary} justify-center self-start`}>Voir l&apos;abonnement</button>
          )}
          {me.has_customer && (
            <button type="button" aria-disabled={busy || undefined} onClick={() => void portal()} className={`${ghost} justify-center self-start`}>
              Gérer mon abonnement
            </button>
          )}
          <p role="status" className="text-sm text-[var(--color-foreground)]/70">{busy ? 'Redirection vers Stripe…' : ''}</p>
          {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
        </>
      )}
    </Section>
  )
}
