import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TradeComposer } from '@/components/trades/TradeComposer'
import { Loading } from '@/components/ui/Loading'

export const metadata: Metadata = { title: 'Nouvel échange' }

// Coquille statique : useSearchParams (with, parent) suspend jusqu'au client, sous ce Suspense (use-search-params.md).
export default function NewTradePage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense fallback={<Loading label="Chargement de l'échange" />}>
        <TradeComposer />
      </Suspense>
    </div>
  )
}
