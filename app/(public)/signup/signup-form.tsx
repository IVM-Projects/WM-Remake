'use client'

import Link from 'next/link'
import { useRef, useState, type FocusEvent, type FormEvent } from 'react'
import { Field, FormError, linkClass } from '@/components/auth/Field'
import { OtpForm } from '@/components/auth/OtpForm'
import { Submit } from '@/components/auth/Submit'
import { useCaptcha } from '@/components/auth/Turnstile'
import { TERMS_VERSION, authErrorMessage, usernameProblem } from '@/lib/auth'
import { createBrowserSupabase } from '@/lib/supabase/browser'

// supabase-js envoie X-Supabase-Api-Version : GoTrue masque alors le refus du trigger sous ce message (500, sans code côté client).
const MASKED_TRIGGER = 'Database error saving new user'

const checkbox = 'flex min-h-11 items-start gap-3 text-sm'
const box = 'mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]'

export function SignupForm() {
  const captcha = useCaptcha()
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const check = useRef<ReturnType<typeof setTimeout>>(undefined)
  const off = !captcha.token || pending || !!usernameError

  // Vérification préalable du pseudo ; la réponse d'une ancienne valeur est ignorée.
  function checkUsername(e: FocusEvent<HTMLInputElement>) {
    const input = e.currentTarget
    const u = input.value
    clearTimeout(check.current)
    if (!u) return
    check.current = setTimeout(async () => {
      // Réseau en échec : le trigger d'inscription vérifie de toute façon.
      const problem = await usernameProblem(u).catch(() => null)
      if (input.value === u) setUsernameError(problem)
    }, 300)
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (off) return
    const f = new FormData(e.currentTarget)
    const [username, address, password] = ['username', 'email', 'password'].map((k) => String(f.get(k)))
    setPending(true)
    setError(null)
    const { error } = await createBrowserSupabase().auth.signUp({
      email: address,
      password,
      options: {
        data: { username, age_confirmed: true, terms_version: TERMS_VERSION },
        captchaToken: captcha.take(),
        emailRedirectTo: `${location.origin}/callback?next=/pulls`,
      },
    })
    if (!error) return setEmail(address)
    // Refus masqué du trigger : le consentement étant garanti par le formulaire, seul le pseudo peut en être la cause.
    const problem = error.message === MASKED_TRIGGER ? await usernameProblem(username).catch(() => null) : null
    setPending(false)
    if (problem) setUsernameError(problem)
    else setError(authErrorMessage(error))
  }

  // Chargement complet (voir LoginForm) : un /pulls préchargé sans session rendrait /login depuis le cache du routeur.
  if (email) return <OtpForm email={email} onVerified={() => window.location.replace('/pulls')} />

  return (
    <form id="signup-form" onSubmit={submit} className="flex flex-col gap-4">
      <Field
        id="username"
        label="Pseudo"
        autoComplete="username"
        minLength={3}
        maxLength={24}
        error={usernameError}
        onBlur={checkUsername}
        onChange={() => setUsernameError(null)}
      />
      <Field id="email" label="Adresse courriel" type="email" autoComplete="email" />
      <Field id="password" label="Mot de passe" type="password" autoComplete="new-password" minLength={6} />
      <label className={checkbox}>
        <input type="checkbox" name="age" required className={box} />
        <span>Je confirme avoir au moins 18 ans et je comprends que les cartes proviennent de Wikipédia et peuvent inclure du contenu sensible.</span>
      </label>
      <label className={checkbox}>
        <input type="checkbox" name="terms" required className={box} />
        <span>
          J&apos;accepte les <Link href="/terms" className="font-medium text-accent underline hover:text-accent-light">Conditions d&apos;utilisation</Link> et les{' '}
          <Link href="/rules" className="font-medium text-accent underline hover:text-accent-light">Règles de la communauté</Link>.
        </span>
      </label>
      {captcha.widget}
      {error && <FormError>{error}</FormError>}
      <Submit off={off}>Créer mon compte</Submit>
      <p className="text-sm text-foreground/70">
        Déjà inscrit ? <Link href="/login" className={linkClass}>Se connecter</Link>
      </p>
    </form>
  )
}
