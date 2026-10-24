import { createECDH, randomBytes } from 'node:crypto'
import { expect, test } from 'vitest'
import webpush from 'web-push'
import { decryptPush, verifyVapid } from './push-crypto.ts'

test('decryptPush : aller-retour avec webpush.encrypt (aes128gcm) ; un octet du corps changé lève', () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = randomBytes(16)
  const { cipherText } = webpush.encrypt(ua.getPublicKey('base64url'), auth.toString('base64url'), 'é ok', 'aes128gcm')
  expect(decryptPush(cipherText, ua, auth)).toBe('é ok')
  const bad = Buffer.from(cipherText)
  bad[bad.length - 20] ^= 1
  expect(() => decryptPush(bad, ua, auth)).toThrow()
})

test('verifyVapid : aud, sub, exp du JWT de getVapidHeaders ; une autre clé publique, ou un k= étranger, lève', () => {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys()
  const other = webpush.generateVAPIDKeys().publicKey
  const { Authorization } = webpush.getVapidHeaders('http://127.0.0.1:54321', 'mailto:push@example.invalid', publicKey, privateKey, 'aes128gcm')
  const now = Math.floor(Date.now() / 1000)
  const claims = verifyVapid(Authorization, publicKey)
  expect(claims).toStrictEqual({ aud: 'http://127.0.0.1:54321', sub: 'mailto:push@example.invalid', exp: expect.any(Number) })
  expect(claims.exp).toBeGreaterThan(now)
  expect(() => verifyVapid(Authorization, other)).toThrow()
  expect(() => verifyVapid(Authorization.replace(/k=.*$/, `k=${other}`), publicKey)).toThrow()
})
