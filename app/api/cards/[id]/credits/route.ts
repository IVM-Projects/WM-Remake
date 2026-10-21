import { z } from 'zod'
import { route } from '@/lib/route'

// Licence de l'image (M2-16) : aucune donnée de joueur, donc sans session et cachée au CDN.
export const GET = route({
  fn: 'card_credits',
  auth: false,
  params: z.object({ id: z.uuid() }),
  args: (_, { params }) => ({ p_card_id: params.id }),
  // Vercel-Cache-Tag : revalidateTag('catalog', 'max') du cron purge aussi la copie de 30 jours du CDN.
  headers: { 'Cache-Control': 'public, max-age=86400, s-maxage=2592000', 'Vercel-Cache-Tag': 'catalog' },
})
