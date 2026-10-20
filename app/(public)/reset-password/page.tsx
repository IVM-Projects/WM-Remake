import type { Metadata } from 'next'
import { ResetForm } from './reset-form'

export const metadata: Metadata = { title: 'Nouveau mot de passe' }

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm space-y-6 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Nouveau mot de passe</h1>
        <ResetForm />
      </div>
    </main>
  )
}
