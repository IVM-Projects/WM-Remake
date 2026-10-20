import type { Metadata } from 'next'
import { brand } from '@/lib/brand'
import { VerifyEmail } from './verify-email'

export const metadata: Metadata = { title: 'Vérifier l\'e-mail' }

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm space-y-6 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Vérifier l&apos;e-mail</h1>
        <p className="text-sm text-foreground/70">Confirme ton adresse e-mail pour activer ton compte {brand.name}.</p>
        <VerifyEmail />
      </div>
    </main>
  )
}
