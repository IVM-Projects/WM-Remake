import type { Metadata } from 'next'
import Link from 'next/link'
import { linkClass } from '@/components/auth/Field'
import { TERMS_VERSION } from '@/lib/auth'

export const metadata: Metadata = { title: 'Conditions d\'utilisation' }

// Page d'attente : le texte définitif arrive avant l'ouverture publique.
export default function TermsPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-prose space-y-4 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Conditions d&apos;utilisation</h1>
        <p className="text-sm text-foreground/70">Version provisoire du {TERMS_VERSION}.</p>
        <p className="text-sm">
          Le texte complet des conditions d&apos;utilisation sera publié ici prochainement. En créant un compte, vous confirmez avoir au
          moins 18 ans et vous acceptez que les cartes proviennent de Wikipédia et puissent inclure du contenu sensible.
        </p>
        <Link href="/signup" className={linkClass}>
          Retour à l&apos;inscription
        </Link>
      </div>
    </main>
  )
}
