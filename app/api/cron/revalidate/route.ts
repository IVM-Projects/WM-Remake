import { revalidateTag } from 'next/cache'
import { cronDenied } from '@/lib/cron'

// Appelée par catalog.yml après un chargement (M2-15) ; hors route() : aucun appel wm.
export async function POST(req: Request): Promise<Response> {
  const denied = cronDenied(req)
  if (denied) return denied
  revalidateTag('catalog', 'max')
  return Response.json({ revalidated: true })
}
