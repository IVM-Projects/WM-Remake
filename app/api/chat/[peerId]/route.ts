import { route } from '@/lib/route'
import { ChatBody, PeerParams } from '@/lib/schemas'

// Lisible sans amitié (M4b-9) ; aucun marquage lu ici, il passe par le PATCH direct de rest/v1/chat_messages.
export const GET = route({ fn: 'chat_thread', params: PeerParams, args: (_, { params }) => ({ p_peer_id: params.peerId }) })

export const POST = route({
  fn: 'chat_send',
  params: PeerParams,
  input: ChatBody,
  idem: true,
  status: 201,
  args: (i, { params }) => ({ p_peer_id: params.peerId, p_content: i.content }),
})
