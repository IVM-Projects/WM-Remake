import { route } from '@/lib/route'
import { ImageReportParams } from '@/lib/schemas'

const params = ImageReportParams
const set = (reported: boolean) => ({ args: (_: undefined, { params }: { params: { id: string } }) => ({ p_card_id: params.id, p_reported: reported }) })

export const GET = route({ fn: 'card_image_report_get', params, args: (_, { params }) => ({ p_card_id: params.id }) })

export const POST = route({ fn: 'card_image_report_set', params, idem: true, ...set(true) })

export const DELETE = route({ fn: 'card_image_report_set', params, idem: true, ...set(false) })
