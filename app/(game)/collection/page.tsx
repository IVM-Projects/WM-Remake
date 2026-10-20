import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { CollectionClient } from './collection-client'

const entry = navEntry('/collection')
export const metadata: Metadata = { title: entry.title }

// Coquille statique : CollectionClient y rend l'en-tête une fois, hors du Suspense de la grille (useSearchParams) ;
// la collection se lit au client, avec ses filtres dans l'adresse.
export default function CollectionPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <CollectionClient />
    </div>
  )
}
