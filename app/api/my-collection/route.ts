import { route } from '@/lib/route'
import { CollectionQuery, filterArgs } from '@/lib/schemas'

// pending et stats acceptés sans effet (D§7.3) : z.object les retire avant SQL.
export const GET = route({
  fn: 'my_collection',
  input: CollectionQuery,
  args: (i) => ({ ...filterArgs(i), p_page: i.page, p_limit: i.limit, p_sort: i.sort }),
})
