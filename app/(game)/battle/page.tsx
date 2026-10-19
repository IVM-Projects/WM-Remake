import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { ComingSoon } from '@/components/shell/PageHeader'

const entry = navEntry('/battle')
export const metadata: Metadata = { title: entry.title }

export default function BattlePage() {
  return <ComingSoon entry={entry} />
}
