import { expect, it } from 'vitest'
import { forbiddenKeys, idCounts } from './leak.ts'

it('forbiddenKeys : une clé interdite imbriquée est rendue par son chemin, tableaux compris ; answered et correct_answer_id passent', () => {
  const body = {
    battle: { game_state: { pendingAttack: { answered: [], questions: [{ id: 'q', options: [{ id: 'o', text: 't', evidence: 'e' }] }] } } },
    decks: [{ q_index: 0 }],
    correct_answer_id: 'o',
    answer: 1,
  }
  expect(forbiddenKeys(body, true)).toEqual(['battle.game_state.pendingAttack.questions.0.options.0.evidence', 'decks.0.q_index', 'answer'])
  expect(forbiddenKeys({ a: { correct_option_id: null } }, false)).toEqual(['a.correct_option_id'])
  expect(forbiddenKeys(null, false)).toEqual([])
})

it('forbiddenKeys : correct permis au premier niveau d\'une réponse seulement, jamais plus bas', () => {
  expect(forbiddenKeys({ correct: true, correct_answer_id: 'o' }, true)).toEqual([])
  expect(forbiddenKeys({ correct: true }, false)).toEqual(['correct'])
  expect(forbiddenKeys({ correct: true, battle: { correct: false } }, true)).toEqual(['battle.correct'])
  expect(forbiddenKeys([{ correct: true }], true)).toEqual(['0.correct'])
})

it('idCounts : n(t, v) de C23 (split), un id préfixe d\'un autre compté aussi dans celui-ci, un id absent à 0', () => {
  expect(idCounts('"abc","abc","ab"', ['ab', 'abc', 'zz'])).toEqual([3, 2, 0])
  expect(idCounts('aaaa', ['aa'])).toEqual([2])
})
