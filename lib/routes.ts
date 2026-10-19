// Pages connectées : sans session, proxy.ts renvoie vers /login.
export const GAME_PREFIXES: readonly string[] = [
  '/pulls', '/collection', '/global-collection', '/trades', '/marketplace', '/profile', '/guild',
  '/friends', '/dms', '/battle', '/achievements', '/leaderboard', '/settings', '/admin',
]

export function isGameRoute(pathname: string): boolean {
  return GAME_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
