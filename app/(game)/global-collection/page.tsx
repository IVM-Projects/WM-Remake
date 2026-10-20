import type { Metadata } from 'next'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { GlobalClient } from './global-client'

const entry = navEntry('/global-collection')
export const metadata: Metadata = { title: entry.title }

// Coquille statique ; le catalogue se lit au client (/api/cards), comme sur l'original.
export default function GlobalCollectionPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <div className="space-y-1">
        <PageHeader title={entry.title} icon={entry.icon} />
        <p className="text-sm text-[var(--color-foreground)]/70">Toutes les cartes existantes dans le jeu</p>
      </div>
      <GlobalClient />
    </div>
  )
}
