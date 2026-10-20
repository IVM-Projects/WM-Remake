'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Field, FormError, linkClass } from '@/components/auth/Field'
import { Submit } from '@/components/auth/Submit'
import { useCaptcha } from '@/components/auth/Turnstile'
import { VERIFY_EMAIL_KEY, authErrorMessage } from '@/lib/auth'
import { safeNext } from '@/lib/gate'
import { createBrowserSupabase } from '@/lib/supabase/browser'

export function LoginForm() {
  const router = useRouter()
  const captcha = useCaptcha()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const off = !captcha.token || pending

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (off) return
    const f = new FormData(e.currentTarget)
    const email = String(f.get('email'))
    setPending(true)
    setError(null)
    const { error } = await createBrowserSupabase().auth.signInWithPassword({
      email,
      password: String(f.get('password')),
      options: { captchaToken: captcha.take() },
    })
    // Chargement complet et non router.replace : le routeur garderait un préchargement fait sans session (/pulls redirigé
    // vers /login) et les pages gardées en mémoire (Activity, préférences) d'une autre session. `next` lu dans l'adresse
    // au moment de l'envoi : la page reste statique, sans Suspense.
    if (!error) return window.location.replace(safeNext(new URLSearchParams(location.search).get('next')))
    setPending(false)
    if (error.code === 'email_not_confirmed') {
      sessionStorage.setItem(VERIFY_EMAIL_KEY, email)
      return router.push('/verify-email')
    }
    setError(authErrorMessage(error))
  }

  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-4">
      <Field id="email" label="Adresse courriel" type="email" autoComplete="email" />
      <Field id="password" label="Mot de passe" type="password" autoComplete="current-password" />
      <Link href="/forgot-password" className={`${linkClass} self-start`}>
        Mot de passe oublié ?
      </Link>
      {captcha.widget}
      {error && <FormError>{error}</FormError>}
      <Submit off={off}>Se connecter</Submit>
      <p className="text-sm text-foreground/70">
        Pas encore de compte ? <Link href="/signup" className={linkClass}>Créer un compte</Link>
      </p>
    </form>
  )
}

// ?error=invalid : lien d'e-mail refusé par /callback. Rendu au client sous Suspense, le formulaire reste statique.
export function CallbackError() {
  return useSearchParams().has('error') ? <FormError>Lien invalide ou expiré</FormError> : null
}
