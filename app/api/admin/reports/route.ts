import { route } from '@/lib/route'
import { ReportsQuery } from '@/lib/schemas'

export const GET = route({ fn: 'staff_reports', input: ReportsQuery, args: (i) => ({ p_status: i.status, p_page: i.page }) })
