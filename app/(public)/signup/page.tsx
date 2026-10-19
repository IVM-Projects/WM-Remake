import type { Metadata } from 'next'
import Link from 'next/link'

// « Inscription — {marque} » par le gabarit de titre du layout racine.
export const metadata: Metadata = { title: 'Inscription' }

export default function SignupPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm space-y-4 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Inscription</h1>
        <p className="text-sm text-[var(--color-foreground)]/70">L&apos;inscription arrive bientôt.</p>
        <Link href="/" className="inline-flex min-h-11 items-center rounded-xl text-sm font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-light)]">
          Retour à l&apos;accueil
        </Link>
      </div>
    </main>
  )
}
