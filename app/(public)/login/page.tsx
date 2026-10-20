import type { Metadata } from 'next'
import { LoginForm } from './login-form'

// « Connexion — {marque} » par le gabarit de titre du layout racine.
export const metadata: Metadata = { title: 'Connexion' }

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm space-y-6 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Connexion</h1>
        <LoginForm />
      </div>
    </main>
  )
}
