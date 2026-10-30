import { describe, expect, it } from 'vitest'
import { membersLabel } from './types'

describe('membersLabel', () => {
  it('singulier à 1, pluriel sinon, milliers séparés', () => {
    expect(membersLabel(1)).toBe('1 membre')
    expect(membersLabel(2)).toBe('2 membres')
    expect(membersLabel(200)).toBe('200 membres')
    expect(membersLabel(1200)).toBe('1 200 membres')
  })
})
