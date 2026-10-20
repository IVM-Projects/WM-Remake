'use client'

import Link from 'next/link'
import { useSyncExternalStore } from 'react'
import { linkClass } from '@/components/auth/Field'
import { OtpForm } from '@/components/auth/OtpForm'
import { VERIFY_EMAIL_KEY } from '@/lib/auth'

const noop = () => () => {}

export function VerifyEmail() {
  // Posée par /login (compte non confirmé). undefined au rendu serveur et à l'hydratation : rien d'envoyable dans le HTML statique.
  const email = useSyncExternalStore(noop, () => sessionStorage.getItem(VERIFY_EMAIL_KEY), () => undefined)
  if (email === undefined) return null
  if (!email) {
    return (
      <p className="text-sm text-foreground/70">
        Adresse inconnue : <Link href="/login" className={linkClass}>Se connecter</Link> ou{' '}
        <Link href="/signup" className={linkClass}>Créer un compte</Link>
      </p>
    )
  }
  return (
    <OtpForm
      email={email}
      onVerified={() => {
        sessionStorage.removeItem(VERIFY_EMAIL_KEY)
        // Chargement complet (voir LoginForm) : un /pulls préchargé sans session rendrait /login depuis le cache du routeur.
        window.location.replace('/pulls')
      }}
    />
  )
}
