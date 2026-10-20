import type { Metadata } from 'next'
import Link from 'next/link'
import { linkClass } from '@/components/auth/Field'

export const metadata: Metadata = { title: 'Règles de la communauté' }

// Page d'attente : le texte définitif arrive avant l'ouverture publique.
export default function RulesPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-prose space-y-4 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Règles de la communauté</h1>
        <p className="text-sm">
          Les règles de la communauté seront publiées ici prochainement. D&apos;ici là, nous vous demandons de rester courtois avec les
          autres joueurs et de ne pas tricher.
        </p>
        <Link href="/signup" className={linkClass}>
          Retour à l&apos;inscription
        </Link>
      </div>
    </main>
  )
}
