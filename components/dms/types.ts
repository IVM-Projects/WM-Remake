// Formes de /api/chat (B2, M4b-9 ; contract/spec/chat.ts).
export type Message = { id: string; sender_id: string; recipient_id: string; content: string; read: boolean; created_at: string; username?: string }
// Chat de guilde (GET /api/guilds/chat, contract/spec/guilds.ts) : l'auteur est user_id, son pseudo est joint.
export type GuildChat = { id: string; user_id: string; content: string; created_at: string; username: string }
export type Conversation = {
  peer_id: string
  peer_username: string
  peer_avatar_url: string | null
  last_message: string
  last_message_at: string
  unread_count: number
}
export type Thread = { messages: Message[]; peer: { id: string; username: string; avatar_url: string | null }; isFriend: boolean }
