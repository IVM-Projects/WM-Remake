// Décalage horloge locale → serveur, mesuré sur l'en-tête Date des réponses /api (même origine : Date lisible).
let offset: number | null = null

// Date est tronquée à la seconde et lue après la latence : chaque mesure minore le vrai décalage, l'estimation retarde sans jamais avancer.
// Un compte à rebours finit donc après le serveur, et le paquet est là quand on relit le stock.
// Une mesure plus basse de moins d'une seconde n'est que cette troncature (on garde la meilleure) ; au-delà, l'horloge locale a sauté.
export function noteServerDate(res: Response): void {
  const date = Date.parse(res.headers.get('Date') ?? '')
  if (Number.isNaN(date)) return
  const measured = date - Date.now()
  if (offset === null || measured > offset || offset - measured >= 1000) offset = measured
}

export const serverNow = (): number => Date.now() + (offset ?? 0)

// Un store plutôt qu'un état : une page réaffichée (Activity) lit l'heure du moment, pas celle de son départ.
// Sondé 4 fois par seconde : un minuteur en retard ne fait jamais sauter ni figer une seconde (rendu seulement quand elle change).
// Un seul minuteur pour tous les abonnés (500 tuiles = 1 setInterval), lancé au premier abonnement, arrêté au dernier départ.
const listeners = new Set<() => void>()
let clock: ReturnType<typeof setInterval> | undefined

export function subscribeClock(cb: () => void) {
  listeners.add(cb)
  clock ??= setInterval(() => listeners.forEach((l) => l()), 250)
  return () => {
    listeners.delete(cb)
    if (listeners.size) return
    clearInterval(clock)
    clock = undefined
  }
}
