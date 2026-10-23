import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { TradesClient } from './trades-client'

const entry = navEntry('/trades')
export const metadata: Metadata = { title: entry.title }

// Coquille statique ; les échanges se lisent au client (/api/trades), rangés d'après la session du navigateur (P16).
export default function TradesPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <TradesClient />
    </div>
  )
}
