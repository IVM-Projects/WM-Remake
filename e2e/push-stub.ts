import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'

// Push simulé (B19) : Notification et PushManager remplacés, service worker réel (public/sw.js, servi sans porte). La CI lance
// chromium-headless-shell, où Notification.permission vaut 'denied' : le getter est toujours posé. Avec `endpoint`, le navigateur
// est déjà abonné à cet endpoint. `answer` : la réponse du joueur à l'invite (« Bloquer » = 'denied') ; `unsubscribeFails` : le
// désabonnement du navigateur lève. Rend l'endpoint de l'abonnement simulé.
export async function stubPush(page: Page, { permission = 'default', endpoint, answer = 'granted', unsubscribeFails = false }:
  { permission?: NotificationPermission; endpoint?: string; answer?: NotificationPermission; unsubscribeFails?: boolean } = {}): Promise<string> {
  // Vraie clé de la courbe : le pre de POST /api/push/subscribe refuse un point hors de P-256.
  const sub = {
    endpoint: endpoint ?? `https://fcm.googleapis.com/fcm/send/e2e-${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: createECDH('prime256v1').generateKeys('base64url'), auth: randomBytes(16).toString('base64url') },
  }
  await page.addInitScript(({ sub, permission, subscribed, answer, unsubscribeFails }) => {
    let state: NotificationPermission = subscribed ? 'granted' : permission
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state })
    Notification.requestPermission = async () => (state = state === 'denied' ? 'denied' : answer)
    const fake = { endpoint: sub.endpoint, expirationTime: null, toJSON: () => sub, unsubscribe: async () => {
      if (unsubscribeFails) throw new DOMException('Désabonnement impossible', 'InvalidStateError')
      current = null
      return true
    } }
    let current: typeof fake | null = subscribed ? fake : null
    // Comme un vrai navigateur : sans permission accordée, subscribe lève.
    PushManager.prototype.subscribe = async () => {
      if (state !== 'granted') throw new DOMException('Permission refusée', 'NotAllowedError')
      return (current = fake) as unknown as PushSubscription
    }
    PushManager.prototype.getSubscription = async () => current as unknown as PushSubscription | null
    if (subscribed) {
      // Déjà abonné : le worker s'enregistre au chargement, et getRegistration() l'attend.
      const sw = navigator.serviceWorker
      const registered = sw.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      const getRegistration = sw.getRegistration.bind(sw)
      sw.getRegistration = (url) => registered.then(() => getRegistration(url))
    }
  }, { sub, permission, subscribed: !!endpoint, answer, unsubscribeFails })
  return sub.endpoint
}
