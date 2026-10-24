import { createHash, timingSafeEqual } from 'node:crypto'
import { fail, type HttpError } from '@/lib/route'

// Empreintes de même longueur : timingSafeEqual ne révèle ni le contenu ni la longueur du secret.
const digest = (s: string) => createHash('sha256').update(s).digest()
// Réponse des routes /api/cron/*, hors route() : Retry-After sur chaque 503 (D§8.1), comme route().
export const reply = ({ status, body }: HttpError) => Response.json(body, { status, headers: status === 503 ? { 'Retry-After': '1' } : undefined })

// Garde des routes /api/cron/* (B5) : la réponse d'un refus, ou null. Secret absent → échec fermé.
export function cronDenied(req: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return reply(fail(503, 'Tâche planifiée non configurée.', 'cron_disabled'))
  const given = req.headers.get('x-cron-secret')
  if (given === null || !timingSafeEqual(digest(given), digest(secret))) {
    return reply(fail(401, 'Secret de tâche planifiée invalide.', 'cron_unauthorized'))
  }
  return null
}
