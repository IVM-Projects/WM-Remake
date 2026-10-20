import type { Metadata } from 'next'
import { HowItWorks } from '@/components/packs/HowItWorks'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { PullsClient } from './pulls-client'

const entry = navEntry('/pulls')
export const metadata: Metadata = { title: entry.title }

// Coquille statique (en-tête, aide) ; le stock et l'ouverture vivent côté client, lus à chaque visite.
export default function PullsPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <PageHeader title={entry.title} icon={entry.icon}>
        <HowItWorks />
      </PageHeader>
      <PullsClient />
    </div>
  )
}
