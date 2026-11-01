import { route } from '@/lib/route'

// Export JSON du compte (G10) en pièce jointe ; limité en débit par wm.account_export (429).
export const GET = route({
  fn: 'account_export',
  headers: { 'Content-Disposition': 'attachment; filename="export-compte.json"', 'Cache-Control': 'no-store' },
})
