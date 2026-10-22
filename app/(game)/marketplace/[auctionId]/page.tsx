import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Loading } from '@/components/ui/Loading'
import { AuctionClient } from './auction-client'

export const metadata: Metadata = { title: 'Enchère' }

// Coquille statique (M3-3) : l'enchère se lit au client. useParams suspend sans generateStaticParams (dynamic-routes.md:155-181), donc la
// coquille partagée par toutes les enchères (App Shell) n'a que ce repli : le prefetch d'une tuile ne lit ni ne règle aucune enchère.
export default function AuctionPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense fallback={<Loading label="Chargement de l'enchère" />}>
        <AuctionClient />
      </Suspense>
    </div>
  )
}
