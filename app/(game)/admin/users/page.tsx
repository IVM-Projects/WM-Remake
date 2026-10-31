import { adminTitle, staffRole } from '@/lib/staff'
import { UsersClient } from './users-client'

export const generateMetadata = adminTitle('Joueurs')

// Le rôle (cache de la requête, déjà lu par la garde) ne sert qu'à masquer ce que l'API refuserait ; à défaut, le moindre droit.
export default async function UsersPage() {
  return <UsersClient role={(await staffRole()) ?? 'moderator'} />
}
