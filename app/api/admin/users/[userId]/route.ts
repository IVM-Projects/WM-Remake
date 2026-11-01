import { route } from '@/lib/route'
import { UserParams } from '@/lib/schemas'

export const GET = route({ fn: 'staff_user_detail', params: UserParams, args: (_, { params }) => ({ p_user_id: params.userId }) })
