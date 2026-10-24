import { cronDenied, reply } from '@/lib/cron'
import { drainPush } from '@/lib/push'
import { fail, INTERNAL } from '@/lib/route'

// 10 vagues de 50 envois, chacun borné à 5 s (M4b-19), tiennent dans la minute.
export const maxDuration = 60

// Appelée par wm.push_wake (pg_net, 15 s, M4b-17) ; hors route() : aucun joueur. Push coupé → 503, rien réservé (M4b-16).
export async function POST(req: Request): Promise<Response> {
  const denied = cronDenied(req)
  if (denied) return denied
  try {
    const counts = await drainPush()
    return counts ? Response.json(counts) : reply(fail(503, 'Notifications push non configurées.', 'push_disabled'))
  } catch {
    // Même ligne que le drain d'after() dans route() : l'étape, jamais l'erreur (endpoint ou clé possibles).
    console.error(JSON.stringify({ push: 'drain_failed' }))
    return reply(fail(500, INTERNAL))
  }
}
