// fr-FR sépare les milliers par une espace fine insécable (U+202F) : « 6 974 » (R§5.2).
const int = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

export const formatInt = (n: number): string => int.format(n)

// m:ss arrondi à la seconde supérieure : on n'affiche jamais 0:00 tant qu'il reste du temps.
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
