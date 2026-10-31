import { adminTitle, staffRole } from '@/lib/staff'
import { ReportsClient } from './reports-client'

export const generateMetadata = adminTitle('Signalements')

// Le rôle (cache de la requête, déjà lu par la garde) ne sert qu'à masquer ce que l'API refuserait ; à défaut, le moindre droit.
export default async function ReportsPage() {
  return <ReportsClient role={(await staffRole()) ?? 'moderator'} />
}
