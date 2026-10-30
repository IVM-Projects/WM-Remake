import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { BattleClient } from './battle-client'

export const metadata: Metadata = { title: navEntry('/battle').title }

// Coquille statique ; batailles, quota et amis se lisent au client (/api/battles, /api/friends), d'après la session du navigateur (P16).
export default function BattlePage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <BattleClient />
    </div>
  )
}
