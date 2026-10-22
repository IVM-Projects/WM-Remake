import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Loading } from '@/components/ui/Loading'
import { AuctionClient } from './auction-client'

export const metadata: Metadata = { title: 'Enchère' }

// useParams suspend sans generateStaticParams (dynamic-routes.md:155-181) : la coquille prefetchée n'a que ce repli, sans lecture.
export default function AuctionPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense fallback={<Loading label="Chargement de l'enchère" />}>
        <AuctionClient />
      </Suspense>
    </div>
  )
}
