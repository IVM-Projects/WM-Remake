import { toast } from '@/components/ui/toast'
import { ApiError, apiOnce, calendarTz } from './api'

// « Défier » un ami (lobby, profil, C17) : une Idempotency-Key par ami, gardée tant que l'issue est inconnue (apiOnce), le quota suivant le
// fuseau du navigateur. Une bataille déjà ouverte avec lui (409 + battle_id) n'est pas un échec : on y mène. Un 2xx au corps illisible ou
// sans id lève une Error simple, que unsure() tient pour incertaine.
export async function challengeFriend(keys: Map<string, string>, opponentId: string): Promise<{ id: string; existing: boolean }> {
  let r: { id?: unknown } | null
  try {
    r = await apiOnce<{ id?: unknown } | null>(keys, `challenge:${opponentId}`, '/api/battles', {
      method: 'POST',
      body: JSON.stringify({ opponent_id: opponentId }),
      headers: calendarTz(),
    })
  } catch (e) {
    const id = e instanceof ApiError && e.status === 409 ? (e.body as { battle_id?: unknown } | null)?.battle_id : undefined
    if (typeof id === 'string') return { id, existing: true }
    throw e
  }
  if (typeof r?.id !== 'string') throw new Error('Réponse du défi illisible')
  return { id: r.id, existing: false }
}

// Suite d'un défi abouti (lobby, profil, PF19) : l'arène seulement si la page est encore affichée (une réponse tardive n'emmène pas
// ailleurs un joueur parti entre-temps), et toujours le toast.
export function afterChallenge(router: { push: (href: string) => void }, res: { id: string; existing: boolean }, username: string,
  onScreen: boolean): void {
  if (onScreen) router.push(`/battle/${res.id}`)
  toast(res.existing ? `Une bataille est déjà en cours avec ${username}.` : `Défi envoyé à ${username}.`)
}
