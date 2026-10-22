import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Loading } from '@/components/ui/Loading'
import { TradeClient } from './trade-client'

export const metadata: Metadata = { title: 'Échange' }

// useParams suspend sans generateStaticParams (dynamic-routes.md:155-181) : la coquille prefetchée n'a que ce repli, sans lecture.
export default function TradePage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense fallback={<Loading label="Chargement de l'échange" />}>
        <TradeClient />
      </Suspense>
    </div>
  )
}
