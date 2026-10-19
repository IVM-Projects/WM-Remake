import { describe, it, expect } from 'vitest'
import { gateDecision, gateToken, isGateCookieValid, safeNext } from '@/lib/gate'

describe('porte démo', () => {
  it.each([
    ['/api/health', 'pass'], ['/api/stripe/webhook', 'pass'], ['/api/cron/push', 'pass'], ['/gate', 'pass'],
    ['/robots.txt', 'pass'], ['/icon', 'pass'],
    ['/', 'redirect'], ['/pulls', 'redirect'], ['/GATE', 'redirect'], ['/api/health/../pulls', 'unauthorized'],
    ['/api/cronx', 'unauthorized'], ['/api/health2', 'unauthorized'], ['/api/marketplace', 'unauthorized'],
    ['/api/cron/../marketplace', 'unauthorized'],
  ])('porte active sans cookie : %s → %s', (p, d) => expect(gateDecision(p, true, false)).toBe(d))
  it('cookie valide ou porte inactive → pass', () => {
    expect(gateDecision('/pulls', true, true)).toBe('pass')
    expect(gateDecision('/api/marketplace', false, false)).toBe('pass')
  })
  it.each([['/collection', '/collection'], ['//evil.example', '/pulls'], ['/\\evil', '/pulls'],
    ['https://evil.example', '/pulls'], [null, '/pulls'], ['/pulls?x=1', '/pulls?x=1'],
    ['/\t/evil.example', '/pulls'], ['javascript:alert(1)', '/pulls'], ['', '/pulls'],
    ['/.//evil.example', '/pulls'], ['/x/..//evil.example', '/pulls'], ['/%2e//evil.example', '/pulls'],
    ['/./\\evil.example', '/pulls']])('safeNext(%j) = %j', (i, o) => expect(safeNext(i)).toBe(o))
  it('jeton de porte vérifiable et lié au mot de passe', async () => {
    const t = await gateToken('k', 'pw')
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(await isGateCookieValid(t, 'k', 'pw')).toBe(true)
    expect(await isGateCookieValid(t, 'k', 'autre')).toBe(false)
    expect(await isGateCookieValid(t, 'autre-secret', 'pw')).toBe(false)
    expect(await isGateCookieValid(undefined, 'k', 'pw')).toBe(false)
    expect(await isGateCookieValid('', 'k', 'pw')).toBe(false)
  })
})
