'use client'

import { usePathname } from 'next/navigation'
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ShopDialog } from '@/components/shop/ShopDialog'
import { toast } from '@/components/ui/toast'
import { api } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { CHECKOUT_SESSION } from '@/lib/schemas'
import type { ShopState } from '@/lib/shop'

type Shop = {
  state: ShopState | null
  failed: boolean
  reload: () => Promise<void>
  setBalance: (b: number) => void
  openShop: () => void
}

const Ctx = createContext<Shop | null>(null)

export function useShop(): Shop {
  const shop = useContext(Ctx)
  if (!shop) throw new Error('useShop hors de ShopProvider')
  return shop
}

const POLL_MS = 2000
const POLL_UNTIL_MS = 30_000
const CANCELLED = 'Paiement annulé : rien n\'a été débité.'
const PENDING = 'Ton paiement est en cours de confirmation : il apparaîtra d\'ici quelques minutes.'

// usePathname suspend sous une route au paramètre inconnu du build (/marketplace/[auctionId]) : seul ce composant attend, jamais le contenu.
function OnNavigate({ run }: { run: () => void }) {
  const pathname = usePathname()
  useEffect(() => run(), [pathname, run])
  return null
}

// État de la boutique partagé par la coquille (G42) : solde de l'en-tête, modale, retour de Checkout (G33).
export function ShopProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ShopState | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const current = useRef<ShopState | null>(null)
  // Génération : une réponse de défausse (setBalance) ou une lecture plus récente rend périmée toute lecture partie avant.
  const gen = useRef(0)

  const read = useCallback(async (session?: string): Promise<ShopState | null> => {
    const g = ++gen.current
    let next: ShopState | null = null
    try {
      const r = await api<ShopState | null>(session ? `/api/shop?session=${session}` : '/api/shop')
      // Un 2xx illisible est une lecture en échec.
      if (r && typeof r === 'object' && r.rules && typeof r.me?.balance === 'number') next = r
    } catch {}
    if (g === gen.current) {
      if (next) current.current = next
      setFailed(next === null)
      if (next) setState(next)
    }
    return next
  }, [])
  const reload = useCallback(async () => { await read() }, [read])
  const setBalance = useCallback((b: number) => {
    const s = current.current
    // Rien à corriger tant qu'aucune lecture n'a réussi : on relit.
    if (!s) { void read(); return }
    gen.current++
    const next = { ...s, me: { ...s.me, balance: b } }
    current.current = next
    setFailed(false)
    setState(next)
  }, [read])
  // Boutique ouverte sans ouvreur (retour de Checkout) : Modal rendrait le focus à body ; il va au solde dès que celui-ci existe.
  const bare = useRef(false)
  const openShop = useCallback(() => { bare.current = false; setOpen(true) }, [])
  // Après la fermeture (les nettoyages de Modal sont déjà passés) et à chaque lecture : le solde n'est monté qu'une fois l'état lu,
  // une boutique fermée avant la fin de la première lecture le retrouve donc ici. Le focus déjà ailleurs annule la demande.
  useEffect(() => {
    if (open || !bare.current) return
    const active = document.activeElement
    if (active && active !== document.body) { bare.current = false; return }
    const target = document.querySelector<HTMLElement>('header button[title="Ouvrir la boutique"]')
    if (target) { target.focus(); bare.current = false }
  }, [open, state, failed])
  const quiet = useCallback(() => void read(), [read])

  // Retour au premier plan : le solde a pu bouger ailleurs.
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === 'visible') quiet() }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [quiet])

  // Retour de Checkout : le serveur confirme (le webhook), l'adresse n'accorde rien. Annulé au démontage ; rejoué par un montage neuf (StrictMode), jamais deux sondes à la fois.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const shop = params.get('shop')
    if (shop !== 'success' && shop !== 'cancel') return
    let stopped = false
    const clean = () => {
      const url = new URL(window.location.href)
      url.searchParams.delete('shop')
      url.searchParams.delete('session')
      window.history.replaceState(window.history.state, '', url)
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    void (async () => {
      if (shop === 'cancel') {
        setNotice(CANCELLED)
        bare.current = true
        setOpen(true)
        clean()
        return
      }
      const session = params.get('session')
      if (!session || !CHECKOUT_SESSION.test(session)) {
        clean()
        return
      }
      setConfirming(true)
      const until = Date.now() + POLL_UNTIL_MS
      for (;;) {
        const s = await read(session)
        if (stopped) return
        if (s?.purchase && (s.purchase.item !== 'pro_monthly' || s.me.is_pro)) {
          toast(s.purchase.item === 'pro_monthly' ? 'Bienvenue chez les membres Pro !' : `${formatInt(s.rules.wb_2500)} wikibidous crédités.`)
          break
        }
        if (Date.now() >= until) {
          toast(PENDING, 8000)
          break
        }
        await sleep(POLL_MS)
        if (stopped) return
      }
      setConfirming(false)
      clean()
    })()
    return () => {
      stopped = true
      setConfirming(false)
    }
  }, [read])

  const value = useMemo(() => ({ state, failed, reload, setBalance, openShop }), [state, failed, reload, setBalance, openShop])
  return (
    <Ctx value={value}>
      <Suspense fallback={null}>
        <OnNavigate run={quiet} />
      </Suspense>
      {children}
      {confirming && (
        <p role="status" className="card-frame fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] z-[60] mx-auto max-w-sm px-4 py-3 text-center text-sm font-medium md:bottom-6">
          Paiement reçu, confirmation en cours…
        </p>
      )}
      {open && <ShopDialog notice={notice} onClose={() => { setOpen(false); setNotice(null) }} />}
    </Ctx>
  )
}
