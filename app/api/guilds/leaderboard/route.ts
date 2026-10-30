import { guildBoardCall } from '@/lib/leaderboard-cache'
import { route } from '@/lib/route'

// Classement partagé en cache + guilde du lecteur et compte à rebours hors cache (G11).
export const GET = route({ fn: 'guild_leaderboard', call: guildBoardCall })
