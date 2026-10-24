import 'server-only'
import webpush from 'web-push'
import { brand } from '@/lib/brand'
import { notificationView } from '@/lib/notification-view'
import { createAdminClient } from '@/lib/supabase/admin'
import { vapidConfig } from '@/lib/vapid'

// Ligne de wm.push_claim.
type Claimed = { subscription_id: string; endpoint: string; p256dh: string; auth: string; notification_id: string; type: string; data: Record<string, unknown> }

// Charge chiffrée (B8) : jamais le contenu d'un message, seulement le texte de la cloche. Un fil garde une seule notification affichée.
export function pushPayload(n: { notification_id: string; type: string; data: Record<string, unknown> }): { title: string; body: string; url: string; tag: string } {
  const { text, href } = notificationView(n)
  return { title: brand.name, body: text, url: href ?? '/', tag: n.type === 'chat_message' ? `dm:${n.data.user_id}` : n.notification_id }
}

// Drain de l'outbox, par after() et par /api/cron/push. Sans clés VAPID valides, rien n'est réservé (M4b-16).
// shortcut: au plus 500 lignes par appel, sans boucle (M4b-19) ; le reste part au réveil suivant (15 s) ; boucler si une carte très
// souhaitée fait attendre ses push plusieurs minutes.
export async function drainPush(): Promise<{ sent: number; gone: number; failed: number } | null> {
  const vapidDetails = vapidConfig()
  if (!vapidDetails) return null
  const db = createAdminClient().schema('wm')
  const claim = await db.rpc('push_claim', { p_limit: 500 })
  if (claim.error) throw new Error('push_claim')
  const rows = claim.data as Claimed[]
  // async : generateRequestDetails lève de façon synchrone (p256dh hors de la courbe) ; la levée devient le rejet de cette seule ligne.
  const send = async (row: Claimed): Promise<number> => {
    const details = webpush.generateRequestDetails({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(pushPayload(row)), { TTL: 86_400, vapidDetails })
    // En-têtes en chaînes, sans Content-Length (fetch le calcule) ; le corps copié, details.body.buffer étant le pool partagé de Buffer.
    const headers = Object.fromEntries(Object.entries(details.headers).filter(([k]) => k !== 'Content-Length').map(([k, v]) => [k, String(v)]))
    // Aucune redirection suivie : un 307 rejouerait le POST et son JWT n'importe où (M4b-11).
    const res = await fetch(row.endpoint, {
      method: 'POST', headers, body: new Uint8Array(details.body), redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    // Corps jamais lu : annulé pour libérer la connexion.
    res.body?.cancel().catch(() => {})
    return res.status
  }
  const counts = { sent: 0, gone: 0, failed: 0 }
  const gone = new Set<string>()
  for (let i = 0; i < rows.length; i += 50) {
    const wave = rows.slice(i, i + 50)
    const results = await Promise.allSettled(wave.map(send))
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value >= 200 && r.value < 300) counts.sent++
      else if (r.status === 'fulfilled' && (r.value === 404 || r.value === 410)) {
        counts.gone++
        gone.add(wave[j].subscription_id)
      } else counts.failed++
    })
  }
  if (gone.size) {
    const { error } = await db.rpc('push_gone', { p_subscription_ids: [...gone] })
    if (error) throw new Error('push_gone')
  }
  // Ni endpoint, ni clé, ni uid (aucune PII dans les logs).
  console.log(JSON.stringify({ push: { claimed: rows.length, ...counts } }))
  return counts
}
