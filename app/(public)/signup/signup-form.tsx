'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState, type FocusEvent, type FormEvent } from 'react'
import { Field, FormError, Submit, linkClass } from '@/components/auth/Field'
import { OtpForm } from '@/components/auth/OtpForm'
import { useCaptcha } from '@/components/auth/Turnstile'
import { TERMS_VERSION, authErrorMessage } from '@/lib/auth'
import { createBrowserSupabase } from '@/lib/supabase/browser'

// Message de refus du pseudo (réservé, pris, invalide), ou null s'il est libre.
async function usernameProblem(u: string): Promise<string | null> {
  const body = (await (await fetch(`/api/username-available?u=${encodeURIComponent(u)}`)).json()) as { available?: boolean; error?: string }
  return body.available === false ? body.error ?? null : null
}

const checkbox = 'flex min-h-11 items-start gap-3 text-sm'
const box = 'mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]'

export function SignupForm() {
  const router = useRouter()
  const captcha = useCaptcha()
  const [usernameError, setUsernameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const check = useRef<ReturnType<typeof setTimeout>>(undefined)

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
    // supabase-js envoie X-Supabase-Api-Version, donc GoTrue masque le refus du trigger : consentement garanti, on redemande le pseudo.
    const problem = await usernameProblem(username).catch(() => null)
    setPending(false)
    if (problem) setUsernameError(problem)
    else setError(authErrorMessage(error))
  }

  if (email) return <OtpForm email={email} onVerified={() => router.replace('/pulls')} />

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
      <Submit disabled={!captcha.token || pending || !!usernameError}>Créer mon compte</Submit>
      <p className="text-sm text-foreground/70">
        Déjà inscrit ? <Link href="/login" className={linkClass}>Se connecter</Link>
      </p>
    </form>
  )
}
