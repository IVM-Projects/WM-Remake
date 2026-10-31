import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { LeaderboardClient } from './leaderboard-client'

export const metadata: Metadata = { title: navEntry('/leaderboard').title }

// Coquille statique ; les classements se lisent au client.
export default function LeaderboardPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <LeaderboardClient />
    </div>
  )
}
