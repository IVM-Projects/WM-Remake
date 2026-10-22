import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { FriendsClient } from './friends-client'

const entry = navEntry('/friends')
export const metadata: Metadata = { title: entry.title }

// Coquille statique ; amis et demandes se lisent au client (/api/friends), rangés d'après la session du navigateur (P16).
export default function FriendsPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <FriendsClient />
    </div>
  )
}
