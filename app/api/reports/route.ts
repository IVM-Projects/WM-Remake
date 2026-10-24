import { z } from 'zod'
import { route } from '@/lib/route'
import { ReportBody } from '@/lib/schemas'

export const GET = route({
  fn: 'report_get',
  input: z.object({ reportedUserId: z.uuid() }),
  args: (i) => ({ p_reported_user_id: i.reportedUserId }),
})

export const POST = route({
  fn: 'report_upsert',
  input: ReportBody,
  idem: true,
  args: (i) => ({ p_reported_user_id: i.reportedUserId, p_reason: i.reason, p_details: i.details ?? null }),
})
