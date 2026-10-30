import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { GuildClient } from './guild-client'

export const metadata: Metadata = { title: navEntry('/guild').title }

// Coquille statique ; la guilde, ses invitations et ses membres se lisent au client (/api/guilds).
export default function GuildPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <GuildClient />
    </div>
  )
}
