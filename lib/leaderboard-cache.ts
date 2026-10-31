import { cacheLife, cacheTag } from 'next/cache'
import { busy, sharedRpc } from '@/lib/market-cache'
import type { RpcResult } from '@/lib/route'
import { createAdminClient } from '@/lib/supabase/admin'

type GuildBoard = { week_end: string }

// Classement des guildes de la semaine, le même pour tous (G11) ; guild_of et reset_in_ms sont ajoutés par guildBoardCall, hors cache.
export async function sharedGuildBoard(): Promise<RpcResult> {
  'use cache: remote'
  cacheTag('leaderboard')
  const out = await sharedRpc('guild_leaderboard', {})
  if (busy(out)) cacheLife('auction')
  else cacheLife('guilds')
  return out
}

// board et period sont validés par zod avant d'arriver ici (une valeur libre remplirait le cache, G11).
// shortcut: après le lundi, le classement de la semaine peut être servi jusqu'à 120 s périmé (profil players, C16) ; `me` reste frais.
export async function sharedPlayerBoard(board: string, period: string): Promise<RpcResult> {
  'use cache: remote'
  cacheTag('leaderboard')
  const out = await sharedRpc('leaderboard_top', { p_board: board, p_period: period })
  if (busy(out)) cacheLife('auction')
  else cacheLife('players')
  return out
}

const wm = () => createAdminClient().schema('wm')

// GET /api/guilds/leaderboard : partagé + guilde du lecteur + compte à rebours, tous deux hors cache. À la bascule du lundi le cache peut
// rendre l'ancienne semaine (week_end passé) : le classement est alors relu hors cache pour cette requête (G11).
export async function guildBoardCall(args: Record<string, unknown>): Promise<RpcResult> {
  const shared = await sharedGuildBoard()
  if (shared.error) return shared
  let board = shared.data as GuildBoard
  if (Date.parse(board.week_end) <= Date.now()) {
    const fresh = await wm().rpc('guild_leaderboard')
    if (fresh.error) return fresh
    board = fresh.data as GuildBoard
  }
  const mine = await wm().rpc('guild_of', { p_uid: args.p_uid })
  if (mine.error) return mine
  return { data: { ...board, reset_in_ms: Math.max(0, Date.parse(board.week_end) - Date.now()), user_guild_id: mine.data }, error: null }
}

// GET /api/leaderboard : partagé + rang du lecteur hors cache (nul à 0, D-C14).
export async function playerBoardCall(args: Record<string, unknown>): Promise<RpcResult> {
  const shared = await sharedPlayerBoard(args.p_board as string, args.p_period as string)
  if (shared.error) return shared
  const me = await wm().rpc('leaderboard_me', { p_uid: args.p_uid, p_board: args.p_board, p_period: args.p_period })
  if (me.error) return me
  return { data: { ...(shared.data as object), me: me.data ?? null }, error: null }
}
