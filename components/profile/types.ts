import type { CardFace } from '@/components/card/Card'
import type { CatalogCard } from '@/components/card/CardModal'
import type { RarityCode } from '@/lib/rarity'

// Profil de wm.profile_json (B2) : sans bio quand il est privé et lu par un non-ami (M4b-5).
export type Profile = { id: string; username: string; avatar_url: string | null; bio?: string | null; is_public: boolean; created_at: string }

// GET /api/profile/{username} ; friendship : la ligne de la paire, quel qu'en soit le statut.
export type ProfileView = {
  profile: Profile
  isOwn: boolean
  isFriend: boolean
  friendship: { id: string; status: 'pending' | 'accepted'; requester_id: string } | null
}

// Copie d'un autre joueur (B2), dans sa vitrine ou sa collection : card est l'objet card de wm.my_collection.
export type CopyFace = { id: string; card: CatalogCard; count: number; is_shiny: boolean; snapshot_rarity: RarityCode }

// Emplacement de vitrine (B2) ; un emplacement vide n'a pas d'entrée.
export type ShowcaseItem = { position: number; user_card_id: string; user_card: CopyFace }

// La copie d'un autre ne porte que sa rareté figée (C11) : titre et stats restent ceux de la carte. Le faceOf de CardModal lit une copie à soi.
export const copyFace = (c: CopyFace): CardFace => ({ ...c.card, rarity: c.snapshot_rarity })
