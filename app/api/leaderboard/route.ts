import { playerBoardCall } from '@/lib/leaderboard-cache'
import { route } from '@/lib/route'
import { LeaderboardQuery } from '@/lib/schemas'

export const GET = route({
  fn: 'leaderboard_top',
  input: LeaderboardQuery,
  args: (i) => ({ p_board: i.board, p_period: i.period }),
  call: playerBoardCall,
})
