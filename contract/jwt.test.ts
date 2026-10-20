import { createPublicKey, verify, type JsonWebKey as NodeJwk } from 'node:crypto'
import { expect, it } from 'vitest'
import { generateKeys, signJwt } from './jwt.ts'

it('signJwt signe en ES256, vérifiable avec la clé publique seule (format exigé par GOTRUE_JWT_KEYS)', () => {
  const { privateJwk, publicJwk } = generateKeys()
  const [header, payload, signature] = signJwt(privateJwk, { sub: 'x' }).split('.')
  const key = createPublicKey({ key: publicJwk as NodeJwk, format: 'jwk' })
  const data = Buffer.from(`${header}.${payload}`)
  expect(verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  expect(publicJwk.d).toBeUndefined()
  expect(privateJwk).toMatchObject({ kid: 'wm-test-es256', alg: 'ES256', use: 'sig', key_ops: ['sign', 'verify'] })
  expect(publicJwk).toMatchObject({ kid: 'wm-test-es256', key_ops: ['verify'] })
})
