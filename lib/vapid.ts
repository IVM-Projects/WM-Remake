import { createECDH } from 'node:crypto'

// Clés VAPID lues à l'appel, sans web-push (lu aussi par la route des préférences). Les contrôles de web-push (vapid-helper.js:68-133) sont
// faits ici : toute valeur qu'il refuserait coupe le push (null, M4b-16) au lieu de lever à chaque envoi. La clé publique est toujours
// dérivée de VAPID_PRIVATE (M4b-14) : VAPID_PUBLIC n'est jamais lue.
export function vapidConfig(): { subject: string; publicKey: string; privateKey: string } | null {
  const privateKey = process.env.VAPID_PRIVATE
  const subject = process.env.VAPID_SUBJECT
  if (!privateKey || !/^[A-Za-z0-9_-]{43}$/.test(privateKey) || !subject) return null
  try {
    if (!['https:', 'mailto:'].includes(new URL(subject).protocol)) return null
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'))
    return { subject, publicKey: ecdh.getPublicKey('base64url'), privateKey }
  } catch {
    return null
  }
}
