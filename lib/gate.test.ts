import { afterEach, describe, it, expect, vi } from 'vitest'
import { gateDecision, gateEnv, gateToken, isGateCookieValid, safeNext } from '@/lib/gate'

describe('porte démo', () => {
  it.each([
    ['/api/health', 'pass'], ['/api/stripe/webhook', 'pass'], ['/api/cron/push', 'pass'], ['/gate', 'pass'],
    ['/robots.txt', 'pass'], ['/icon', 'pass'], ['/sw.js', 'pass'],
    ['/', 'redirect'], ['/sw.jsx', 'redirect'], ['/pulls', 'redirect'], ['/GATE', 'redirect'], ['/api/health/../pulls', 'unauthorized'],
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
  describe('gateEnv()', () => {
    afterEach(() => vi.unstubAllEnvs())
    const env = (password: string, secret: string) => {
      vi.stubEnv('DEMO_GATE_PASSWORD', password)
      vi.stubEnv('GATE_COOKIE_SECRET', secret)
    }
    it('les deux variables → porte active', () => {
      env('pw', 'k')
      expect(gateEnv()).toEqual({ password: 'pw', secret: 'k' })
    })
    it('aucune (ou vides) → porte inactive', () => {
      env('', '')
      expect(gateEnv()).toBeNull()
    })
    it.each([['pw', ''], ['', 'k']])('une seule (%j, %j) → erreur, jamais porte inactive', (password, secret) => {
      env(password, secret)
      expect(() => gateEnv()).toThrow(/DEMO_GATE_PASSWORD et GATE_COOKIE_SECRET/)
    })
  })
})
