// fr-FR sépare les milliers par une espace fine insécable (U+202F) : « 6 974 » (R§5.2).
const int = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

export const formatInt = (n: number): string => int.format(n)

// Unité après un montant, « 1 wikibidou », « 2 wikibidous » : 0 et 1 au singulier, comme le veut le français (SelectionBar.tsx).
export const wikibidous = (n: number): string => (n > 1 ? 'wikibidous' : 'wikibidou')

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

// Date et heure fr-FR, à la seconde (historique des mises, ventes) : « 21/10/2026 14:03:12 », heure locale du joueur.
const when = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })
export const formatDateTime = (iso: string): string => when.format(new Date(iso))

// Date courte fr-FR d'une offre (R§6.8) : « 20 sept. », heure locale du joueur.
const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })
export const formatShortDate = (iso: string): string => day.format(new Date(iso))

// Mois en toutes lettres et année fr-FR (« Membre depuis octobre 2026 »), heure locale du joueur.
const monthYear = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' })
export const formatMonthYear = (iso: string): string => monthYear.format(new Date(iso))

// Heure courte fr-FR d'un message (« 14:03 »), heure locale du joueur.
const time = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' })
export const formatTime = (iso: string): string => time.format(new Date(iso))

// Date en toutes lettres fr-FR (« 21 octobre 2026 ») : séparateur de jour du fil de /dms, heure locale du joueur.
const longDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' })
export const formatLongDate = (iso: string): string => longDate.format(new Date(iso))
