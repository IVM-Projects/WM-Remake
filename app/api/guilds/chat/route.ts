import { route } from '@/lib/route'
import { ChatBody } from '@/lib/schemas'

export const GET = route({ fn: 'guild_chat_list' })

export const POST = route({ fn: 'guild_chat_send', input: ChatBody, idem: true, status: 201, args: (i) => ({ p_content: i.content }) })
