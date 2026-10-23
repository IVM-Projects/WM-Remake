import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { Loading } from '@/components/ui/Loading'
import { DmsClient } from './dms-client'

const entry = navEntry('/dms')
export const metadata: Metadata = { title: entry.title }

// Coquille statique : useSearchParams (with) suspend jusqu'au client, sous ce Suspense (use-search-params.md). DmsClient rend l'en-tête,
// dont le h1 est une cible du focus ; le repli le montre déjà.
export default function DmsPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense fallback={<><PageHeader title={entry.title} icon={entry.icon} /><Loading label="Chargement des conversations" /></>}>
        <DmsClient />
      </Suspense>
    </div>
  )
}
