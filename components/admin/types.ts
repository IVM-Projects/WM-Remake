import type { RarityCode } from '@/lib/rarity'

export type StaffRole = 'admin' | 'moderator'

export type Health = {
  settle_lag_s: number | null
  overdue_s: number | null
  push_lag_s: number | null
  quiz: { queued: number | null; oldest_s: number | null } | null
}

export type Dashboard = {
  open_reports: number
  image_reports: number
  auto_hidden_cards: number
  active_sanctions: number
  removed_cards: number
  auth_pending: number
  health: Health
}

export type AuditRow = {
  id: number
  staff_id: string | null
  staff_username: string | null
  action: string
  target_type: string
  target_id: string
  reason: string
  created_at: string
}

export type AuditPage = { actions: AuditRow[]; hasMore: boolean }

export const TARGET_TYPES = [
  ['user', 'Joueur'], ['card', 'Carte'], ['guild', 'Guilde'], ['guild_message', 'Message de guilde'], ['guild_wish', 'Souhait'],
  ['dm', 'Message privé'], ['dm_pair', 'Paire de joueurs'], ['report', 'Signalement'], ['sanction', 'Sanction'],
] as const

export const ACTION_LABELS: Record<string, string> = {
  sanction: 'Sanction', sanction_revoke: 'Sanction levée', auth_sync: 'Session resynchronisée', achievements_recheck: 'Check rouvert',
  report_review: 'Signalement traité', dm_read: 'Messages lus', dm_delete: 'Message supprimé', card_flags: 'Drapeaux d\'image',
  image_auto_hide: 'Image masquée d\'office', card_remove: 'Carte retirée', card_restore: 'Carte remise', quiz_clear: 'Banque effacée',
  guild_dissolve: 'Guilde dissoute', guild_message_delete: 'Message de guilde supprimé', guild_wish_remove: 'Souhait retiré',
  ban_carryover: 'Bannissement reporté',
}

export type SanctionKind = 'warning' | 'restriction' | 'suspension' | 'ban'
export type Sanction = {
  id: number
  kind: SanctionKind
  reason: string | null
  starts_at: string
  ends_at: string | null
  revoked_at: string | null
  active: boolean
}
export type Sanctioned = { sanction: Sanction; auth_synced: boolean }
export type SearchUser = { id: string; username: string; created_at: string; deleted: boolean }
export type UserDetail = {
  user: { id: string; username: string; is_pro: boolean; is_vip: boolean; balance: number; is_public: boolean; deleted_at: string | null; auth_pending: boolean }
  staff_role: StaffRole | null
  sanctions: Sanction[]
  reports_received: number
  reports_filed: number
  guild: { id: string; name: string } | null
}

export type Who = { id: string; username: string | null }
export type ReportRow = {
  id: string
  reason: string
  details: string | null
  created_at: string
  reporter: Who
  reported: Who
  review: { status: 'resolved' | 'dismissed'; reviewed_at: string; reviewed_by_username: string | null } | null
  active_sanctions: number
}
export type ImageRow = {
  card_id: string
  wikipedia_title: string
  image_url: string | null
  hide_image: boolean
  nsfw_image: boolean
  reports: number
}
export type DmMessage = { id: string; sender_username: string | null; content: string; created_at: string }

export type CardDetail = {
  card: { id: string; wikipedia_title: string; rarity: RarityCode; image_url: string | null; hide_image: boolean; nsfw_image: boolean; in_pool: boolean }
  removal: { reason: string; removed_at: string; removed_by_username: string | null } | null
  image_reports: number
  quiz_bank: boolean
  engagements: { active_auctions: number; pending_trades: number; open_wishes: number; showcase: number; avatars: number }
}
export type RemovalRow = { card_id: string; wikipedia_title: string; reason: string; removed_at: string; removed_by_username: string | null }

export type GuildHit = { id: string; name: string; member_count: number; leader_username: string | null }
export type GuildDetail = {
  guild: { id: string; name: string; description: string | null; leader_id: string | null; created_at: string }
  members: { user_id: string; username: string; role: string; joined_at: string }[]
  messages: { id: string; user_id: string; username: string; content: string; created_at: string }[]
  wishes: { id: string; user_id: string; username: string; card_id: string; wikipedia_title: string; created_at: string }[]
}
