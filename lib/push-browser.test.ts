import { createECDH } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fromBase64Url, subscribePush } from '@/lib/push-browser'

describe('fromBase64Url', () => {
  it('« BAEC » → [4, 1, 2]', () => expect(fromBase64Url('BAEC')).toEqual(new Uint8Array([4, 1, 2])))
  it('« - » et « _ » décodés comme « + » et « / »', () => expect([...fromBase64Url('-_-_')]).toEqual([...Buffer.from('+/+/', 'base64')]))
  it('clé VAPID publique sans « = » (87 caractères) → ses 65 octets', () => {
    const key = createECDH('prime256v1')
    expect(Buffer.from(fromBase64Url(key.generateKeys('base64url')))).toEqual(key.getPublicKey())
  })
})

describe('subscribePush', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('permission d\'abord, puis register ; subscribe une seule fois, sur la registration de ready, une fois ready résolu', async () => {
    const calls: string[] = []
    // Registration de register() : son worker est encore « installing » au premier enregistrement (Chromium refuserait subscribe).
    const early = { pushManager: { subscribe: vi.fn() } }
    const reg = { pushManager: { subscribe: vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://push.example/x' }) })) } }
    let resolve!: (r: typeof reg) => void
    const ready = new Promise<typeof reg>((r) => { resolve = r })
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => { calls.push('permission'); return 'granted' }) })
    const register = vi.fn(async () => { calls.push('register'); return early })
    vi.stubGlobal('navigator', { serviceWorker: { register, ready } })

    const sub = subscribePush('BAEC')
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual(['permission', 'register'])
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' })
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()

    resolve(reg)
    expect(await sub).toEqual({ endpoint: 'https://push.example/x' })
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([4, 1, 2]) })
    expect(early.pushManager.subscribe).not.toHaveBeenCalled()
  })
})
