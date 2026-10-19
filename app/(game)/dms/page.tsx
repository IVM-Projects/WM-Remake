import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { ComingSoon } from '@/components/shell/PageHeader'

const entry = navEntry('/dms')
export const metadata: Metadata = { title: entry.title }

export default function DmsPage() {
  return <ComingSoon entry={entry} />
}
