import { afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'

afterEach(() => vi.unstubAllEnvs())

describe('proxy : configuration invalide → 500', () => {
  it.each(['DEMO_GATE_PASSWORD', 'GATE_COOKIE_SECRET'])('%s seule (porte à moitié configurée)', async (name) => {
    vi.stubEnv('DEMO_GATE_PASSWORD', '')
    vi.stubEnv('GATE_COOKIE_SECRET', '')
    vi.stubEnv(name, 'x')
    // /api/health est exemptée de la porte : seule la vérification de configuration peut la bloquer.
    const res = await proxy(new NextRequest('http://localhost/api/health'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Configuration invalide', message: 'Configuration invalide' })
  })
})

describe('next.config : configuration invalide → échec au build et au démarrage', () => {
  it.each(['DEMO_GATE_PASSWORD', 'GATE_COOKIE_SECRET'])('%s seule', async (name) => {
    vi.stubEnv('DEMO_GATE_PASSWORD', '')
    vi.stubEnv('GATE_COOKIE_SECRET', '')
    vi.stubEnv(name, 'x')
    vi.resetModules()
    await expect(import('./next.config')).rejects.toThrow(/DEMO_GATE_PASSWORD et GATE_COOKIE_SECRET/)
  })
  it('marque d\'origine avec la porte complète → accepté', async () => {
    vi.stubEnv('NEXT_PUBLIC_BRAND_NAME', 'WikiMasters')
    vi.stubEnv('DEMO_GATE_PASSWORD', 'pw')
    vi.stubEnv('GATE_COOKIE_SECRET', 'k')
    vi.resetModules()
    await expect(import('./next.config')).resolves.toBeDefined()
  })
})
