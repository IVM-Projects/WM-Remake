import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { ComingSoon } from '@/components/shell/PageHeader'

const entry = navEntry('/global-collection')
export const metadata: Metadata = { title: entry.title }

export default function GlobalCollectionPage() {
  return <ComingSoon entry={entry} />
}
