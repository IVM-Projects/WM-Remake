'use client'

import Script from 'next/script'
import { useCallback, useEffect, useRef, useState } from 'react'
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

  // Une seule fois par affichage : depuis l'effet si api.js est déjà là, sinon depuis onLoad (chaîné même pendant le chargement).
  const render = useCallback(() => {
    if (!SITE_KEY || widget.current !== null || !box.current || !window.turnstile) return
    widget.current = window.turnstile.render(box.current, {
      sitekey: SITE_KEY,
      theme: 'dark',
      callback: (t) => {
        setFailed(false)
        onTokenRef.current(t)
      },
      'expired-callback': () => onTokenRef.current(''),
      'error-callback': () => {
        setFailed(true)
        onTokenRef.current('')
      },
    })
  }, [])

  useEffect(() => {
    if (!SITE_KEY) {
      onTokenRef.current('dev-bypass')
      return
    }
    render()
    // Remis à null : une page gardée cachée par Cache Components puis réaffichée rend un nouveau widget.
    return () => {
      if (widget.current !== null) window.turnstile?.remove(widget.current)
      widget.current = null
    }
  }, [render])

  if (!SITE_KEY) return null
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" onLoad={render} onError={() => setFailed(true)} />
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
