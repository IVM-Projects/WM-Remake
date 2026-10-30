import type { CardFace } from '@/components/card/Card'
import { ApiError } from '@/lib/api'
import { formatInt } from '@/lib/format'

// Formes des réponses de /api/guilds/** (contract/spec/guilds.ts, leaderboard.ts) ; ids en chaînes simples, jamais z.uuid().
export type Guild = { id: string; name: string; description: string | null; leader_id: string | null; created_at: string }
export type Membership = { guild_id: string; user_id: string; role: 'leader' | 'member'; joined_at: string }
export type GuildInvite = { guild_id: string; guild_name: string; inviter_username: string; created_at: string }
export type GuildState = { guild: Guild | null; membership: Membership | null; member_count: number; invites: GuildInvite[] }
export type Member = { user_id: string; id: string; username: string; role: 'leader' | 'member'; joined_at: string }
export type MemberPage = { members: Member[]; hasMore: boolean }
type Who = { id: string; username: string }
export type Wish = {
  id: string; user_id: string; card: CardFace & { id: string }; created_at: string; can_donate: boolean
  recipient_received_today: boolean; user: Who; recipient: Who; my_copies: { id: string; count: number; is_shiny: boolean }[]
}
export type GuildHome = {
  my_wishlist: Wish | null; wishlists: Wish[]; received_donation_today: boolean
  weekly_karma_donors: { user_id: string; username: string; karma: number; karma_this_week: number; donations_this_week: number }[]
}
export type ChatMessage = { id: string; user_id: string; content: string; created_at: string; username: string }
export type GuildBoardData = {
  entries: { rank: number; guild_id: string; guild_name: string; member_count: number; score_battles: number; score_wb: number; total_score: number }[]
  week_start: string; week_end: string; season: string; reset_in_ms: number; user_guild_id: string | null
}

export const membersLabel = (n: number): string => (n === 1 ? '1 membre' : `${formatInt(n)} membres`)

export const NO_GUILD = 'Tu n\'es dans aucune guilde'
// Refus d'une lecture ou d'une écriture d'onglet par un joueur qui n'est plus membre (exclu, guilde dissoute).
export const isNoGuild = (e: unknown): boolean => e instanceof ApiError && e.status === 404 && e.message === NO_GUILD

// Corps lisible de GET /api/guilds et des écritures qui rendent l'état (join, create) ; un 2xx illisible (null) ne l'est pas.
export const isGuildState = (r: unknown): r is GuildState => typeof r === 'object' && r !== null && 'guild' in r && Array.isArray((r as GuildState).invites)
