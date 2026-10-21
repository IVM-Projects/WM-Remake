import { createHash, timingSafeEqual } from 'node:crypto'
import { revalidateTag } from 'next/cache'
import { fail, type HttpError } from '@/lib/route'

// Empreintes de même longueur : timingSafeEqual ne révèle ni le contenu ni la longueur du secret.
const digest = (s: string) => createHash('sha256').update(s).digest()
const reply = ({ status, body }: HttpError) => Response.json(body, { status })

// Appelée par catalog.yml après un chargement (M2-15) ; hors route() : aucun appel wm. Secret absent → échec fermé.
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret) return reply(fail(503, 'Tâche planifiée non configurée.', 'cron_disabled'))
  const given = req.headers.get('x-cron-secret')
  if (given === null || !timingSafeEqual(digest(given), digest(secret))) {
    return reply(fail(401, 'Secret de tâche planifiée invalide.', 'cron_unauthorized'))
  }
  revalidateTag('catalog', 'max')
  return Response.json({ revalidated: true })
}
