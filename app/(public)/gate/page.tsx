import type { Metadata } from 'next'
import { Suspense } from 'react'
import { GateForm } from './gate-form'

// Seule page servie devant la porte : titre absolu, sans la marque (qui peut être celle d'origine).
export const metadata: Metadata = { title: { absolute: 'Démo privée' } }

async function GateFormWithNext({ searchParams }: Pick<PageProps<'/gate'>, 'searchParams'>) {
  const { next } = await searchParams
  return <GateForm next={typeof next === 'string' ? next : ''} />
}

export default function GatePage({ searchParams }: PageProps<'/gate'>) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm p-6 animate-fade-in-up">
        <h1 className="mb-6 text-2xl font-bold">Démo privée</h1>
        {/* Le shell statique porte déjà un formulaire ; `next` arrive à la requête. */}
        <Suspense fallback={<GateForm next="" />}>
          <GateFormWithNext searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  )
}
