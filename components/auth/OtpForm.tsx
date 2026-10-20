'use client'

import { useState, type FormEvent } from 'react'
import { authErrorMessage } from '@/lib/auth'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import { Field, FormError } from './Field'
import { Submit } from './Submit'
import { useCaptcha } from './Turnstile'

// Code à 6 chiffres de la config Auth ; le champ en accepte 6 à 12 (R§2.1).
export function OtpForm({ email, onVerified }: { email: string; onVerified: () => void }) {
  const captcha = useCaptcha() // GoTrue protège aussi /resend
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    const token = String(new FormData(e.currentTarget).get('otp'))
    setPending(true)
    setError(null)
    const { error } = await createBrowserSupabase().auth.verifyOtp({ email, token, type: 'signup' })
    if (!error) return onVerified()
    setPending(false)
    setError(authErrorMessage(error))
  }

  async function resend() {
    if (pending || !captcha.token) return
    setPending(true)
    setError(null)
    setSent(false)
    const { error } = await createBrowserSupabase().auth.resend({ type: 'signup', email, options: { captchaToken: captcha.take() } })
    setPending(false)
    if (error) setError(authErrorMessage(error))
    else setSent(true)
  }

  return (
    <form onSubmit={verify} className="flex flex-col gap-4">
      <p className="text-sm text-foreground/70">Saisis le code envoyé à {email}.</p>
      <Field
        id="signup-otp-code"
        name="otp"
        label="Code de confirmation"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6,12}"
        maxLength={12}
      />
      {error && <FormError>{error}</FormError>}
      <Submit off={pending}>Valider le code</Submit>
      {captcha.widget}
      <button
        type="button"
        onClick={resend}
        aria-disabled={pending || !captcha.token}
        className="rounded-xl bg-accent/10 px-4 py-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
      >
        Renvoyer le code
      </button>
      <p role="status" className="text-sm text-foreground/70">
        {sent && 'Nouveau code envoyé.'}
      </p>
    </form>
  )
}
