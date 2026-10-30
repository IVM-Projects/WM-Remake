import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { fakeQuestions } from './fake-upstream.ts'
import type { QueueCard } from './generate.ts'
import { norm, validate, type Question, type Rule } from './schema.ts'

const cards = JSON.parse(readFileSync(new URL('./fixtures/cards.json', import.meta.url), 'utf8')) as QueueCard[]

const ctx = {
  title: 'Loire',
  text: 'La Loire est le plus long fleuve de France. Elle prend sa source au mont Gerbier-de-Jonc, en Ardèche. Son estuaire s\'ouvre '
    + 'sur l\'océan Atlantique à Saint-Nazaire.',
}
const first: Question = { prompt: 'Quel mot complète la phrase : « La Loire est le plus long ____ de France. » ?',
  options: ['fleuve', 'canal', 'lac', 'torrent'], correct: 0, evidence: 'La Loire est le plus long fleuve de France.' }
const second: Question = { prompt: 'Quel mot complète la phrase : « Son ____ s\'ouvre sur l\'océan Atlantique à Saint-Nazaire. » ?',
  options: ['delta', 'estuaire', 'barrage', 'port'], correct: 1, evidence: 'Son estuaire s\'ouvre sur l\'océan Atlantique à Saint-Nazaire.' }

test('norm (C20)', () => {
  expect(norm('Œuvre d’Élise !')).toBe('oeuvre d elise')
})

test('deux questions valides : toutes deux gardées, aucun refus', () => {
  expect(validate([first, second], ctx)).toEqual({ kept: [first, second], rejected: {} })
})

// Un cas par règle de validate (PF8 : json et store naissent dans generate.ts) : seule la seconde question est refusée.
test.each<[Rule, string, unknown]>([
  ['shape', '3 options', { ...second, options: ['delta', 'estuaire', 'barrage'] }],
  ['shape', 'correct à 4', { ...second, correct: 4 }],
  // Chaînes que jsonb refuse : norm en ferait une espace, la question passerait toutes les autres règles.
  ['shape', 'U+0000 dans l\'evidence', { ...second, evidence: `${second.evidence}\u0000` }],
  ['shape', 'surrogate isolé dans l\'énoncé', { ...second, prompt: `${second.prompt} \ud83d` }],
  ['shape', 'U+0000 dans une option', { ...second, options: ['delta', 'estuaire', 'barrage', 'port\u0000'] }],
  ['lengths', 'énoncé de 6', { ...second, prompt: 'Quoi ?' }],
  ['distinct', 'Delta, delta !', { ...second, options: ['estuaire', 'Delta', 'delta !', 'port'], correct: 0 }],
  ['evidence_source', 'evidence hors du texte', { ...second, evidence: 'Son estuaire s\'ouvre sur la mer du Nord, près de Calais.' }],
  ['answer_in_evidence', 'réponse hors de l\'evidence', { ...second, correct: 0 }],
  ['distractor_in_evidence', 'distracteur dans l\'evidence', { ...second, options: ['delta', 'estuaire', 'barrage', 'Océan'] }],
  ['answer_in_prompt', 'réponse dans l\'énoncé', { ...second, prompt: 'Quel estuaire s\'ouvre sur l\'océan Atlantique ?' }],
  ['title', 'réponse = titre', { ...first, prompt: 'Quel est le plus long fleuve de France ?', options: ['Seine', 'Loire', 'Rhône', 'Garonne'],
    correct: 1 }],
  ['title', 'énoncé réduit au titre', { ...first, prompt: 'Qu\'est-ce que la Loire ?' }],
  ['forbidden', 'lien dans une option', { ...second, options: ['delta', 'estuaire', 'barrage', 'https://x.fr'] }],
  ['forbidden', 'aucune', { ...second, options: ['delta', 'estuaire', 'barrage', 'Aucune de ces réponses'] }],
  ['forbidden', 'question sur les vues', { ...second, prompt: 'Quel article a le plus de vues sur Wikipédia ce mois-ci ?' }],
  ['duplicate', 'même réponse', { ...first, prompt: 'Quel cours d\'eau traverse Orléans, Blois et Tours ?' }],
  ['duplicate', 'énoncés à Jaccard > 0,7', { ...second, prompt: first.prompt }],
])('%s (%s)', (rule, _label, bad) => {
  expect(validate([first, bad], ctx)).toEqual({ kept: [first], rejected: { [rule]: 1 } })
})

// Règle title en mots entiers : « Mozart » n'est pas refusé pour « Art », ni « avion » et « lion » ôtés de l'énoncé pour « Io » (il en
// resterait un seul mot plein) ; une réponse qui contient le titre en mot entier l'est toujours.
test('title en mots entiers', () => {
  const art = { title: 'Art', text: 'Mozart compose la Flûte enchantée en 1791 à Vienne, peu avant sa mort. L\'art lyrique y triomphe alors.' }
  const mozart = { prompt: 'Quel compositeur écrit la Flûte enchantée en 1791 ?', options: ['Mozart', 'Haydn', 'Salieri', 'Gluck'], correct: 0,
    evidence: 'Mozart compose la Flûte enchantée en 1791 à Vienne, peu avant sa mort.' }
  const lyric = { prompt: 'Quel genre triomphe alors à Vienne ?', options: ['art lyrique', 'ballet', 'chanson', 'fugue'], correct: 0,
    evidence: 'L\'art lyrique y triomphe alors.' }
  expect(validate([mozart, lyric], art)).toEqual({ kept: [mozart], rejected: { title: 1 } })
  const io = { title: 'Io', text: 'Un avion transporte le lion du cirque vers la ménagerie de Lyon.' }
  const q = { prompt: 'Vers quoi l\'avion transporte-t-il le lion ?', options: ['ménagerie', 'volière', 'écurie', 'serre'], correct: 0,
    evidence: io.text }
  expect(validate([q], io)).toEqual({ kept: [q], rejected: {} })
})

test('kept coupé à 6', () => {
  const text = cards.map((c) => c.summary).join(' ')
  const all = fakeQuestions(text, 'Titre absent')
  expect(all).toHaveLength(8)
  expect(validate(all, { title: 'Titre absent', text })).toEqual({ kept: all.slice(0, 6), rejected: {} })
})

test.each(cards.map((c) => [c.title, c] as const))('fiche %s : résumé de 200 caractères ou plus, au moins 3 questions de fakeQuestions gardées', (_t, c) => {
  const text = c.summary ?? ''
  expect(text.length).toBeGreaterThanOrEqual(200)
  expect(validate(fakeQuestions(text, c.title), { title: c.title, text }).kept.length).toBeGreaterThanOrEqual(3)
})
