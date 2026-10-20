import type { Metadata } from 'next'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { SettingsClient } from './settings-client'

const entry = navEntry('/settings')
export const metadata: Metadata = { title: entry.title }

// Coquille statique ; pseudo et préférences se lisent au client, section par section.
export default function SettingsPage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <PageHeader title={entry.title} icon={entry.icon} />
      <SettingsClient />
    </div>
  )
}
