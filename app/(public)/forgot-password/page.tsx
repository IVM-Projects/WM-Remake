import type { Metadata } from 'next'
import { ForgotForm } from './forgot-form'

export const metadata: Metadata = { title: 'Mot de passe oublié' }

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm space-y-6 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Mot de passe oublié</h1>
        <p className="text-sm text-foreground/70">Nous vous enverrons un lien pour choisir un nouveau mot de passe.</p>
        <ForgotForm />
      </div>
    </main>
  )
}
