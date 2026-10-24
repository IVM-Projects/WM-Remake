// Côté spec (M4b-32) : déchiffre une livraison du faux service et vérifie son JWT VAPID ; la passerelle ne garde aucune clé.
import assert from 'node:assert/strict'
import { createDecipheriv, createPublicKey, hkdfSync, verify, type ECDH } from 'node:crypto'

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
const contentInfo = (label: string) => Buffer.from(`Content-Encoding: ${label}\0`)

// ua : la paire de l'abonnement (p256dh), auth : son secret de 16 octets.
export function decryptPush(body: Buffer, ua: ECDH, auth: Buffer): string {
  // En-tête RFC 8188 §2 : salt (16) | rs (uint32) | idlen (1) | keyid, ici la clé publique éphémère du serveur (RFC 8291 §4).
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const asPublic = body.subarray(21, 21 + body[20])
  const record = body.subarray(21 + body[20])
  assert.ok(record.length <= rs, 'un push tient en un seul enregistrement (RFC 8291 §4)')
  // RFC 8291 §3.3-3.4, puis la clé et le nonce de RFC 8188 §2.2-2.3.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic])
  const ikm = hkdf(ua.computeSecret(asPublic), auth, keyInfo, 32)
  const decipher = createDecipheriv('aes-128-gcm', hkdf(ikm, salt, contentInfo('aes128gcm'), 16), hkdf(ikm, salt, contentInfo('nonce'), 12))
  decipher.setAuthTag(record.subarray(-16))
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()])
  // Délimiteur 0x02 du dernier enregistrement, suivi de zéros de remplissage.
  const end = padded.findLastIndex((b) => b !== 0)
  assert.equal(padded[end], 2, 'délimiteur du dernier enregistrement')
  return padded.subarray(0, end).toString('utf8')
}

// En-tête `vapid t=<jwt>, k=<clé publique>` (RFC 8292 §3) ; lève sur toute signature fausse ou un k= étranger.
export function verifyVapid(authorization: string, vapidPublic: string): { aud: string; sub: string; exp: number } {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization)
  assert.ok(m, 'en-tête Authorization vapid')
  const [, header, payload, signature, k] = m
  const point = Buffer.from(vapidPublic, 'base64url')
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk',
  })
  const signed = verify('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  assert.ok(signed, 'signature VAPID fausse')
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256')
  assert.equal(k, vapidPublic, 'k= autre que la clé publique VAPID')
  const { aud, sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { aud: string; sub: string; exp: number }
  return { aud, sub, exp }
}
