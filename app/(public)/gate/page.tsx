import type { Metadata } from 'next'
import { GateForm } from './gate-form'

// Seule page servie devant la porte : titre absolu, sans la marque (qui peut être celle d'origine).
export const metadata: Metadata = { title: { absolute: 'Démo privée' } }

export default function GatePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-sm p-6 animate-fade-in-up">
        <h1 className="mb-6 text-2xl font-bold">Démo privée</h1>
        <GateForm />
      </div>
    </main>
  )
}
