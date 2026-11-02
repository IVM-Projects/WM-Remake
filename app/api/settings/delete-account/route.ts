import { deleteAccountCall } from '@/lib/admin-auth'
import { route } from '@/lib/route'
import { AccountDelete } from '@/lib/schemas'

// Suppression immédiate du compte (G1) : transaction, résiliation Stripe (stripe_pending si elle échoue, G10), puis suppression douce
// GoTrue (auth_pending si elle échoue).
export const POST = route({
  fn: 'account_delete',
  input: AccountDelete,
  idem: true,
  args: (i) => ({ p_username: i.username }),
  call: deleteAccountCall,
})
