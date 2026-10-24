import { route } from '@/lib/route'
import { ShowcaseBody, ShowcasePosition } from '@/lib/schemas'

export const GET = route({ fn: 'my_showcase' })

export const PUT = route({
  fn: 'showcase_put',
  input: ShowcaseBody,
  idem: true,
  args: (i) => ({ p_position: i.position, p_user_card_id: i.user_card_id }),
})

// Position lue dans le corps JSON du DELETE (R§3.7).
export const DELETE = route({ fn: 'showcase_delete', input: ShowcasePosition, idem: true, args: (i) => ({ p_position: i.position }) })
