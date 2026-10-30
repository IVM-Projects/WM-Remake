import { describe, expect, it } from 'vitest'
import { isGuildState, membersLabel } from './types'

describe('membersLabel', () => {
  it('singulier à 1, pluriel sinon, milliers séparés', () => {
    expect(membersLabel(1)).toBe('1 membre')
    expect(membersLabel(2)).toBe('2 membres')
    expect(membersLabel(200)).toBe('200 membres')
    expect(membersLabel(1200)).toBe('1 200 membres')
  })
})

describe('isGuildState', () => {
  it('accepte un état avec `guild` et `invites` (liste), refuse le reste', () => {
    expect(isGuildState({ guild: null, membership: null, member_count: 0, invites: [] })).toBe(true)
    expect(isGuildState({ guild: null, invites: {} })).toBe(false)
    expect(isGuildState({ invites: [] })).toBe(false)
    expect(isGuildState(null)).toBe(false)
    expect(isGuildState('x')).toBe(false)
  })
})
