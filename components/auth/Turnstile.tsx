'use client'

import Script from 'next/script'
import { useEffect, useRef, useState } from 'react'

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: { sitekey: string; theme: 'dark'; callback(t: string): void; 'expired-callback'(): void }): string
      remove(id: string): void
    }
  }
}

// Sans clé de site (banc, dev) : rien à afficher, jeton 'dev-bypass' (ruling R2 ; le serveur réel le refuse).
export function Turnstile({ onToken }: { onToken: (t: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  useEffect(() => {
    if (!SITE_KEY) onToken('dev-bypass')
    return () => {
      if (widget.current) window.turnstile?.remove(widget.current)
    }
  }, [onToken])
  if (!SITE_KEY) return null
  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        // onReady : aussi à chaque remontage, le script déjà chargé.
        onReady={() => {
          if (box.current && window.turnstile) {
            widget.current = window.turnstile.render(box.current, { sitekey: SITE_KEY, theme: 'dark', callback: onToken, 'expired-callback': () => onToken('') })
          }
        }}
      />
      <div ref={box} />
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
    take(): string | undefined {
      setToken('')
      setRound((r) => r + 1)
      // Sans clé de site, le captcha de GoTrue est désactivé : aucun jeton à lui envoyer.
      return token === 'dev-bypass' ? undefined : token
    },
  }
}
