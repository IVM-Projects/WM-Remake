import { adminTitle, staffRole } from '@/lib/staff'
import { GuildsClient } from './guilds-client'

export const generateMetadata = adminTitle('Guildes')

// Le rôle (cache de la requête, déjà lu par la garde) ne sert qu'à masquer ce que l'API refuserait ; à défaut, le moindre droit.
export default async function GuildsPage() {
  return <GuildsClient role={(await staffRole()) ?? 'moderator'} />
}
