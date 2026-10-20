'use client'

import { useEffect, useRef, useState } from 'react'
import { FormError } from './Field'

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: {
        sitekey: string
        theme: 'dark'
        callback(t: string): void
        'expired-callback'(): void
        'error-callback'(): void
      }): string
      remove(id: string): void
    }
  }
}

let api: Promise<void> | undefined

// api.js chargé une fois pour toutes les instances, y compris celles montées pendant le chargement (next/script ne chaîne onLoad que pour la deuxième).
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  api ??= new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    el.async = true
    el.addEventListener('load', () => (window.turnstile ? resolve() : reject(new Error('turnstile absent'))))
    el.addEventListener('error', () => reject(new Error('api.js injoignable')))
    document.head.append(el)
  })
  return api
}

// Sans clé de site (banc, dev) : rien à afficher, jeton 'dev-bypass' (ruling R2 ; le serveur réel le refuse).
export function Turnstile({ onToken }: { onToken: (t: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  // Dernier onToken sans relancer l'effet : un rappel en ligne ne doit pas recréer le widget.
  const onTokenRef = useRef(onToken)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    onTokenRef.current = onToken
  })

  useEffect(() => {
    if (!SITE_KEY) {
      onTokenRef.current('dev-bypass')
      return
    }
    // alive : une promesse résolue après le démontage (ou la mise en cache de la page) ne rend rien.
    let alive = true
    const fail = () => {
      setFailed(true)
      onTokenRef.current('')
    }
    loadTurnstile().then(
      () => {
        if (!alive || widget.current !== null || !box.current || !window.turnstile) return
        widget.current = window.turnstile.render(box.current, {
          sitekey: SITE_KEY,
          theme: 'dark',
          callback: (t) => {
            setFailed(false)
            onTokenRef.current(t)
          },
          'expired-callback': () => onTokenRef.current(''),
          'error-callback': fail,
        })
      },
      () => {
        if (alive) fail()
      },
    )
    // Remis à null : une page gardée cachée par Cache Components puis réaffichée rend un nouveau widget.
    return () => {
      alive = false
      if (widget.current !== null) window.turnstile?.remove(widget.current)
      widget.current = null
    }
  }, [])

  if (!SITE_KEY) return null
  return (
    <>
      <div ref={box} />
      {failed && <FormError>La vérification anti-bot n&apos;a pas pu se charger, recharge la page.</FormError>}
    </>
  )
}

// Jeton à usage unique : take() le rend pour GoTrue et remonte le widget pour en obtenir un nouveau.
export function useCaptcha() {
  const [token, setToken] = useState('')
  const [round, setRound] = useState(0)
  return {
    token,
    widget: <Turnstile key={round} onToken={setToken} />,
    take(): string {
      setToken('')
      setRound((r) => r + 1)
      return token
    },
  }
}
