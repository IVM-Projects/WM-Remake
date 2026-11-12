import { adminTitle, staffRole } from '@/lib/staff'
import { DashboardClient } from './dashboard-client'

export const generateMetadata = adminTitle('Administration')

// Le rôle (cache de la requête, déjà lu par la garde) ne sert qu'à masquer ce que l'API refuserait ; à défaut, le moindre droit.
export default async function AdminPage() {
  return <DashboardClient role={(await staffRole()) ?? 'moderator'} />
}
