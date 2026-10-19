import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { ComingSoon } from '@/components/shell/PageHeader'

const entry = navEntry('/pulls')
export const metadata: Metadata = { title: entry.title }

export default function PullsPage() {
  return <ComingSoon entry={entry} />
}
