import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { MarketClient } from './market-client'

const entry = navEntry('/marketplace')
export const metadata: Metadata = { title: entry.title }

// Coquille statique ; les enchères se lisent au client (/api/marketplace), comme le catalogue (M3-3).
export default function MarketplacePage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <MarketClient />
    </div>
  )
}
