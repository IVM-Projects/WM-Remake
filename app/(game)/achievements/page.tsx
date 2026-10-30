import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { AchievementsClient } from './achievements-client'

export const metadata: Metadata = { title: navEntry('/achievements').title }

// Coquille statique ; le catalogue et les succès du joueur se lisent au client (REST sous RLS).
export default function AchievementsPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <AchievementsClient />
    </div>
  )
}
