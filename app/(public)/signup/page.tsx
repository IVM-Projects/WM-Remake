import type { Metadata } from 'next'
import { SignupForm } from './signup-form'

// « Inscription — {marque} » par le gabarit de titre du layout racine.
export const metadata: Metadata = { title: 'Inscription' }

export default function SignupPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm space-y-6 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Inscription</h1>
        <SignupForm />
      </div>
    </main>
  )
}
