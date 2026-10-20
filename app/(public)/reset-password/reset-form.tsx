'use client'

import Link from 'next/link'
import { useEffect, useState, type FormEvent } from 'react'
import { Field, FormError, linkClass } from '@/components/auth/Field'
import { Submit } from '@/components/auth/Submit'
import { authErrorMessage } from '@/lib/auth'
import { createBrowserSupabase } from '@/lib/supabase/browser'

export function ResetForm() {
  const [state, setState] = useState<'loading' | 'invalid' | 'ready'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // Session posée par /callback ; ?error vient d'un échange de code refusé. Lus après l'hydratation : la page reste statique.
  useEffect(() => {
    const failed = new URLSearchParams(location.search).has('error')
    void createBrowserSupabase().auth.getSession().then(({ data }) => setState(failed || !data.session ? 'invalid' : 'ready'))
  }, [])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    const { error } = await createBrowserSupabase().auth.updateUser({ password: String(new FormData(e.currentTarget).get('password')) })
    // Chargement complet (voir LoginForm) : ni préchargement fait sans session ni page gardée d'une autre session.
    if (!error) return window.location.replace('/pulls')
    setPending(false)
    setError(authErrorMessage(error))
  }

  if (state === 'loading') return null
  if (state === 'invalid') {
    return (
      <div className="flex flex-col gap-4">
        <FormError>Lien invalide ou expiré</FormError>
        <Link href="/forgot-password" className={`${linkClass} self-start`}>
          Demander un nouveau lien
        </Link>
      </div>
    )
  }
  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-4">
      <Field id="password" label="Nouveau mot de passe" type="password" autoComplete="new-password" minLength={6} />
      {error && <FormError>{error}</FormError>}
      <Submit off={pending}>Enregistrer le mot de passe</Submit>
    </form>
  )
}
