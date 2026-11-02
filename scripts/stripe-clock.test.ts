import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STRIPE_API_VERSION, assertTestKey, checkPrices, waitReady } from './stripe-clock.mjs'

const script = fileURLToPath(new URL('./stripe-clock.mjs', import.meta.url))
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], { env: { ...process.env, STRIPE_SECRET_KEY: '', ...env }, encoding: 'utf8' })

describe('assertTestKey', () => {
  it('refuse une clé absente', () => {
    for (const k of [undefined, '']) expect(() => assertTestKey(k)).toThrow('STRIPE_SECRET_KEY absente.')
  })

  it('refuse toute clé hors test sans la recopier', () => {
    for (const k of ['sk_live_x', 'rk_live_x', 'pk_test_x', 'whsec_x']) {
      expect(() => assertTestKey(k)).toThrow('Clé refusée : seule une clé de test (sk_test_ ou rk_test_) est acceptée.')
      try {
        assertTestKey(k)
      } catch (e) {
        expect((e as Error).message).not.toContain(k)
      }
    }
  })

  it('rend une clé de test', () => {
    expect(assertTestKey('sk_test_x')).toBe('sk_test_x')
    expect(assertTestKey('rk_test_x')).toBe('rk_test_x')
  })
})

describe('commande', () => {
  it('refuse une clé live avant tout client, sans la recopier', () => {
    const r = run(['prices'], { STRIPE_SECRET_KEY: 'sk_live_bench_fake' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Clé refusée')
    expect(r.stdout + r.stderr).not.toContain('sk_live_bench_fake')
  })

  it('refuse une commande inconnue avec l\'aide, même sans clé', () => {
    const r = run(['nope'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Usage')
  })

  it('valide les arguments avant la clé', () => {
    expect(run(['start'], { STRIPE_SECRET_KEY: 'sk_test_x' }).status).toBe(1)
    expect(run(['advance', '--clock', 'clock_x', '--days', '0'], { STRIPE_SECRET_KEY: 'sk_test_x' }).status).toBe(1)
  })
})

describe('checkPrices', () => {
  const pro = { unit_amount: 999, currency: 'cad', recurring: { interval: 'month' } }
  const wb = { unit_amount: 499, currency: 'cad', recurring: null }
  it('accepte les Prices conformes à SHOP', () => {
    expect(checkPrices(pro, wb)).toEqual([])
  })
  it('signale chaque écart', () => {
    expect(checkPrices({ ...pro, unit_amount: 1 }, wb)).toHaveLength(1)
    expect(checkPrices(pro, { ...wb, currency: 'usd' })).toHaveLength(1)
    expect(checkPrices({ ...pro, recurring: { interval: 'year' } }, { ...wb, recurring: { interval: 'month' } })).toHaveLength(2)
    expect(checkPrices(pro, { ...wb, unit_amount: null })).toHaveLength(1)
  })
})

describe('waitReady', () => {
  const fake = (statuses: string[]) => {
    let n = 0
    return { testHelpers: { testClocks: { retrieve: async () => ({ status: statuses[Math.min(n++, statuses.length - 1)] }) } } }
  }
  it('attend ready', async () => {
    await expect(waitReady(fake(['advancing', 'advancing', 'ready']) as never, 'clock_x', { sleep: async () => {}, timeoutMs: 10_000 })).resolves.toBeUndefined()
  })
  it('échoue clairement après le délai', async () => {
    let t = 0
    await expect(waitReady(fake(['advancing']) as never, 'clock_x', { sleep: async () => void (t += 2000), now: () => t, timeoutMs: 6000 })).rejects.toThrow('toujours en cours')
  })
})

it('la version d\'API est celle de lib/stripe.ts', () => {
  expect(readFileSync(new URL('../lib/stripe.ts', import.meta.url), 'utf8')).toContain(`STRIPE_API_VERSION = '${STRIPE_API_VERSION}'`)
})
