// fr-FR sépare les milliers par une espace fine insécable (U+202F) : « 6 974 » (R§5.2).
const int = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

export const formatInt = (n: number): string => int.format(n)

// m:ss arrondi à la seconde supérieure : on n'affiche jamais 0:00 tant qu'il reste du temps.
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Compte à rebours d'une enchère (R§2.2, P16) : « 3m 18s », « 1h 02m 05s », « 45s » ; arrondi au-dessus comme formatCountdown.
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}h ${two(m)}m ${two(sec)}s` : m ? `${m}m ${two(sec)}s` : `${sec}s`
}
