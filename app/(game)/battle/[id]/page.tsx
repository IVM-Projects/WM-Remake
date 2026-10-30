import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Loading } from '@/components/ui/Loading'
import { ArenaClient } from './arena-client'

export const metadata: Metadata = { title: 'Bataille' }

// useParams suspend sans generateStaticParams (dynamic-routes.md:155-181) : la coquille prefetchée n'a que ce repli, sans lecture. Les
// paramètres ne sont pas lus ici : hors du Suspense, ils rendraient la route dynamique, ce que la construction refuse (cacheComponents).
export default function ArenaPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense fallback={<Loading label="Chargement de la bataille" />}>
        <ArenaClient />
      </Suspense>
    </div>
  )
}
