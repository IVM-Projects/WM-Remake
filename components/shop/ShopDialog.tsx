'use client'

import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { ShopOffers } from '@/components/shop/ShopOffers'
import { useShop } from '@/components/shop/ShopProvider'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { api, apiOnce, userMessage } from '@/lib/api'
import { PORTAL_FAILED, stripeUrl, type ShopItem } from '@/lib/shop'

const CHECKOUT_FAILED = 'Le paiement n\'a pas pu démarrer.'

// Modale boutique (G21) : enveloppe de ShopOffers, qui lit la boutique partagée et porte les envois vers Stripe.
export function ShopDialog({ onClose, notice = null }: { onClose: () => void; notice?: string | null }) {
  const { state, failed, reload } = useShop()
  const id = useId()
  const [busy, setBusy] = useState<ShopItem | 'portal' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Une clé par intention d'achat, gardée tant que l'issue est inconnue (relance = même Checkout côté serveur).
  const keys = useRef(new Map<string, string>())
  // Garde synchrone : deux clics dans le même tour de rendu ne partent pas deux fois.
  const sending = useRef(false)

  // Retour par l'historique depuis Stripe (page restaurée avec l'envoi encore marqué en cours).
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) { sending.current = false; setBusy(null) }
    }
    window.addEventListener('pageshow', back)
    return () => window.removeEventListener('pageshow', back)
  }, [])

  async function go(intent: ShopItem | 'portal', fallback: string, call: () => Promise<{ url?: unknown } | null>) {
    if (sending.current) return
    sending.current = true
    setBusy(intent)
    setError(null)
    try {
      const url = stripeUrl(await call())
      if (!url) throw new Error('url')
      window.location.assign(url)
    } catch (e) {
      sending.current = false
      setBusy(null)
      setError(userMessage(e, fallback))
    }
  }
  const buy = (item: ShopItem) =>
    go(item, CHECKOUT_FAILED, () => apiOnce(keys.current, item, '/api/stripe/checkout', { method: 'POST', body: JSON.stringify({ item }) }))
  const portal = () => go('portal', PORTAL_FAILED, () => api('/api/stripe/portal', { method: 'POST' }))

  return (
    <Modal onClose={onClose} labelledBy={id} className="card-frame relative w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 animate-fade-in-up">
      <button
        type="button"
        aria-label="Fermer la boutique"
        onClick={onClose}
        className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-light)]"
      >
        <X className="size-6" />
      </button>
      <h2 id={id} className="pr-10 text-xl font-bold">Boutique</h2>
      {notice && <p role="status" className="mt-3 text-sm font-medium">{notice}</p>}
      {failed ? (
        <div className="mt-5">
          <LoadError onRetry={() => void reload()} text="Impossible de charger la boutique." />
        </div>
      ) : state === null ? (
        <Loading label="Chargement de la boutique…" />
      ) : (
        <ShopOffers state={state} busy={busy} error={error} onBuy={(item) => void buy(item)} onPortal={() => void portal()} />
      )}
    </Modal>
  )
}
