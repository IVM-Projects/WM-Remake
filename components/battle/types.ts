import type { CardFace } from '@/components/card/Card'
import type { RarityCode } from '@/lib/rarity'

// Objet Battle de wm.battle_json (C5, C6, contract/spec/battles.ts) ; un pending échu arrive déjà en cancelled (C6).
export type BattleStatus = 'pending' | 'deck_selection' | 'generating_quizzes' | 'active' | 'completed' | 'cancelled'

// Face figée au submit_deck (C4) : snapshot de la copie, sans category (la réponse de T1 n'est pas affichée, M5a-10).
export type FrozenCard = {
  id: string
  user_card_id: string
  wikipedia_title: string
  wikipedia_url: string
  rarity: RarityCode
  atk: number
  def: number
  image_url: string | null
  hide_image: boolean
  nsfw_image: boolean
}

export type PlayerState = { cardIds: string[]; usedCardIds: string[]; currentHp: number; maxHp: number; cards: FrozenCard[] }

// Questions sans bonne réponse : seuls les ids et les textes des 4 options (C7, C23).
export type PendingAttack = {
  attackerUserId: string
  defenderId: string
  attackCardId: string
  attackCardName: string
  questions: { id: string; prompt: string; options: { id: string; text: string }[] }[]
  answered: string[]
}

export type Turn = {
  turnNumber: number
  attackerUserId: string
  defenderId: string
  attackCardId: string
  allCorrect: boolean
  damageDealt: number
  wrong: number
  total: number
}

// Tant qu'un seul deck est posé, le lecteur ne voit que le sien (M5a-11) ; phase et tour à partir d'active.
export type GameState = {
  players: Record<string, PlayerState>
  turnHistory: Turn[]
  phase?: 'attack' | 'quiz' | 'over'
  currentTurnUserId?: string
  turnNumber?: number
  pendingAttack?: PendingAttack | null
  winnerId?: string
  // Points de guilde du gagnant, posés à la fin (M5b-3, G5) ; 0 sans guilde.
  guildPoints?: number
}

export type Battle = {
  id: string
  challenger_id: string
  opponent_id: string
  winner_id: string | null
  status: BattleStatus
  created_at: string
  updated_at: string
  challenger: { id: string; username: string }
  opponent: { id: string; username: string }
  expires_at: string | null
  idle_at: string | null
  // Nul en pending ; absent des batailles closes de la liste (C6).
  game_state?: GameState | null
}

export type BattleDetail = { battle: Battle; decks: { user_id: string; card_ids: string[] }[]; reward: number | null }

// Valeur entière de wm.config.battle (C2, M5a-16).
export type Rules = {
  questions: number
  pool: number
  quota_free: number
  quota_pro: number
  invite_ttl_h: number
  idle_loss_h: number
  reward_win: number
  reward_loss: number
  guild_points_win: number
}

export type Quota = { used: number; limit: number; resets_at: string }

export type BattleList = { battles: Battle[]; challenge_quota: Quota; rules: Rules }

// Clés en plus de la réponse de submit_single_answer (C5, D:531).
export type AnswerResult = { correct: boolean; correct_answer_id: string; last_turn: boolean; status: BattleStatus }

// Une face figée est déjà une CardFace, sans category (C4).
export const toFace = (c: FrozenCard): CardFace => c

export const isOpen = (b: Battle): boolean => b.status !== 'completed' && b.status !== 'cancelled'

// Ligne d'état d'une bataille vue par `me` (lobby).
export function battleLine(b: Battle, me: string): string {
  const other = (b.challenger_id === me ? b.opponent : b.challenger).username
  const g = b.game_state
  switch (b.status) {
    case 'pending':
      return b.opponent_id === me ? 'Défi reçu : à toi de répondre' : `En attente de ${other}`
    case 'deck_selection':
      return 'Choix des cartes'
    case 'generating_quizzes':
      return 'Préparation des questions'
    case 'active':
      if (g?.phase === 'quiz') return g.pendingAttack?.defenderId === me ? 'À toi de répondre' : `Tour de ${other}`
      return g?.currentTurnUserId === me ? 'À toi d\'attaquer' : `Tour de ${other}`
    case 'completed':
      return b.winner_id === me ? 'Victoire' : 'Défaite'
    case 'cancelled':
      return 'Annulée'
  }
}

// L'état relu permet-il encore l'intention `<action>:<bataille>[:<carte>|:<question>]` de `me` ? Sinon sa clé apiOnce est oubliée : une
// relance serait une nouvelle intention, et le serveur la refuse ou rejoue la réponse enregistrée sans clé (C5).
export function allows(b: Battle, me: string, intent: string): boolean {
  const [action, , arg] = intent.split(':')
  const g = b.game_state
  switch (action) {
    case 'accept':
    case 'decline':
    case 'withdraw_invite':
      return b.status === 'pending'
    case 'submit_deck':
      return (b.status === 'deck_selection' || b.status === 'generating_quizzes') && !g?.players[me]
    case 'submit_attack':
      return b.status === 'active' && g?.phase === 'attack' && g.currentTurnUserId === me
    case 'submit_single_answer':
      return b.status === 'active' && !!g?.pendingAttack?.questions.some((q) => q.id === arg) && !g.pendingAttack.answered.includes(arg)
    default:
      return isOpen(b)
  }
}
