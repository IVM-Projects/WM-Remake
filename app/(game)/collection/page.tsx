import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { Loading } from '@/components/ui/Loading'
import { CollectionClient } from './collection-client'

const entry = navEntry('/collection')
export const metadata: Metadata = { title: entry.title }

// Coquille statique ; la collection se lit au client, avec ses filtres dans l'adresse (useSearchParams, d'où le Suspense).
export default function CollectionPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense
        fallback={
          <>
            <PageHeader title={entry.title} icon={entry.icon} />
            <Loading label="Chargement de la collection" />
          </>
        }
      >
        <CollectionClient />
      </Suspense>
    </div>
  )
}
