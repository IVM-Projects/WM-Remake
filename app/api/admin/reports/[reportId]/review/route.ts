import { route } from '@/lib/route'
import { ReportParams, ReportReview } from '@/lib/schemas'

export const POST = route({
  fn: 'admin_report_review',
  params: ReportParams,
  input: ReportReview,
  idem: true,
  args: (i, { params }) => ({ p_report_id: params.reportId, p_status: i.status, p_reason: i.reason }),
})
