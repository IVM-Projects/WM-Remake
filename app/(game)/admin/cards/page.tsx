import { adminTitle, staffRole } from '@/lib/staff'
import { CardsClient } from './cards-client'

export const generateMetadata = adminTitle('Cartes')

// Le rôle (cache de la requête, déjà lu par la garde) ne sert qu'à masquer ce que l'API refuserait ; à défaut, le moindre droit.
export default async function CardsPage() {
  return <CardsClient role={(await staffRole()) ?? 'moderator'} />
}
