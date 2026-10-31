import { route } from '@/lib/route'
import { AdminPageQuery } from '@/lib/schemas'

export const GET = route({ fn: 'staff_image_reports', input: AdminPageQuery, args: (i) => ({ p_page: i.page }) })
