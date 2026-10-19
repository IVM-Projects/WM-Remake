import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { ComingSoon } from '@/components/shell/PageHeader'

const entry = navEntry('/leaderboard')
export const metadata: Metadata = { title: entry.title }

export default function LeaderboardPage() {
  return <ComingSoon entry={entry} />
}
