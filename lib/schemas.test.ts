import { describe, expect, it } from 'vitest'
import { boolParam, CollectionQuery, filterArgs, pageParam, rarityList } from '@/lib/schemas'

describe('schémas de query', () => {
  it('boolParam : 1/true → true ; 0/false/absent → false ; autre → erreur', () => {
    expect(['1', 'true', '0', 'false', undefined].map((v) => boolParam.parse(v))).toEqual([true, true, false, false, false])
    expect(boolParam.safeParse('oui').success).toBe(false)
  })

  it('rarityList : chaîne ou tableau → tableau ; rareté inconnue → erreur', () => {
    expect(rarityList.parse('L')).toEqual(['L'])
    expect(rarityList.parse(['L', 'UR'])).toEqual(['L', 'UR'])
    expect(rarityList.safeParse(['L', 'X']).success).toBe(false)
  })

  it('pageParam : défaut 0, entier ≥ 0 dans un int de PG', () => {
    expect([pageParam.parse(undefined), pageParam.parse('3')]).toEqual([0, 3])
    for (const bad of ['-1', '1.5', 'x', '2147483648']) expect(pageParam.safeParse(bad).success, bad).toBe(false)
  })

  it('CollectionQuery : search → p_q, pending et stats retirés, tri inconnu refusé', () => {
    const i = CollectionQuery.parse({ search: 'abc', pending: '1', stats: '1', rarity: 'L' })
    expect(i).not.toHaveProperty('pending')
    expect(filterArgs(i)).toMatchObject({ p_q: 'abc', p_rarity: ['L'], p_untagged: false })
    expect(CollectionQuery.safeParse({ sort: 'xyz' }).success).toBe(false)
  })
})
