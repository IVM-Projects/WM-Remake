import { route } from '@/lib/route'
import { CollectionFilters, filterArgs } from '@/lib/schemas'

export const GET = route({ fn: 'my_collection_stats', input: CollectionFilters, args: filterArgs })
