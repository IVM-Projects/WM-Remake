import { expect, test } from 'vitest'
import { battleLine, isOpen, type Battle, type GameState } from './types'

const [A, B] = ['a', 'b']
const battle = (status: Battle['status'], game_state: GameState | null = null, winner_id: string | null = null): Battle => ({
  id: 'x', challenger_id: A, opponent_id: B, winner_id, status, created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:00:00Z',
  challenger: { id: A, username: 'Alice' }, opponent: { id: B, username: 'Bob' }, expires_at: null, idle_at: null, game_state,
})
const state = (s: Partial<GameState>): GameState => ({ players: {}, turnHistory: [], ...s })
const quiz = (defenderId: string) => state({ phase: 'quiz', pendingAttack: { attackerUserId: defenderId === A ? B : A, defenderId,
  attackCardId: 'c', attackCardName: 'Carte', questions: [], answered: [] } })

test('battleLine : chaque statut, vu du challenger (A) et du défié (B)', () => {
  expect([battleLine(battle('pending'), A), battleLine(battle('pending'), B)]).toEqual(['En attente de Bob', 'Défi reçu : à toi de répondre'])
  expect(battleLine(battle('deck_selection', state({})), B)).toBe('Choix des cartes')
  expect(battleLine(battle('generating_quizzes', state({})), A)).toBe('Préparation des questions')
  const attack = battle('active', state({ phase: 'attack', currentTurnUserId: A }))
  expect([battleLine(attack, A), battleLine(attack, B)]).toEqual(['À toi d\'attaquer', 'Tour de Alice'])
  expect([battleLine(battle('active', quiz(B)), B), battleLine(battle('active', quiz(B)), A)]).toEqual(['À toi de répondre', 'Tour de Bob'])
  const done = battle('completed', null, B)
  expect([battleLine(done, B), battleLine(done, A)]).toEqual(['Victoire', 'Défaite'])
  expect(battleLine(battle('cancelled'), A)).toBe('Annulée')
})

test('isOpen : tout statut sauf completed et cancelled', () => {
  expect((['pending', 'deck_selection', 'generating_quizzes', 'active', 'completed', 'cancelled'] as const).map((s) => isOpen(battle(s))))
    .toEqual([true, true, true, true, false, false])
})
