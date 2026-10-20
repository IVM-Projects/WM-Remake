'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { Field, FormError, linkClass } from '@/components/auth/Field'
import { Submit } from '@/components/auth/Submit'
import { useCaptcha } from '@/components/auth/Turnstile'
import { authErrorMessage } from '@/lib/auth'
import { createBrowserSupabase } from '@/lib/supabase/browser'

export function ForgotForm() {
  const captcha = useCaptcha()
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  const off = !captcha.token || pending

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (off) return
    setPending(true)
    setError(null)
    setSent(false)
    // Lien PKCE : le vérificateur reste en cookie dans ce navigateur, /callback l'échange contre la session.
    const { error } = await createBrowserSupabase().auth.resetPasswordForEmail(String(new FormData(e.currentTarget).get('email')), {
      redirectTo: `${location.origin}/callback?next=/reset-password`,
      captchaToken: captcha.take(),
    })
    setPending(false)
    if (error) setError(authErrorMessage(error))
    else setSent(true)
  }

  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-4">
      <Field id="email" label="Adresse courriel" type="email" autoComplete="email" />
      {captcha.widget}
      {error && <FormError>{error}</FormError>}
      <Submit off={off}>Envoyer le lien</Submit>
      <p role="status" className="text-sm text-foreground/70">
        {sent && 'Si un compte existe pour cette adresse, un lien vient d\'être envoyé.'}
      </p>
      <Link href="/login" className={`${linkClass} self-start`}>
        Retour à la connexion
      </Link>
    </form>
  )
}
