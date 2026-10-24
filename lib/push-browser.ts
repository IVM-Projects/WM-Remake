// Abonnement push du navigateur (Task 14) : lu par la section de /settings et par « Se déconnecter ». Le serveur n'en sait rien
// tant que la ligne n'est pas envoyée (POST /api/push/subscribe).

// Base64url (clé VAPID publique, sans « = ») en octets : l'applicationServerKey de pushManager.subscribe.
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
}

const registration = () => navigator.serviceWorker.getRegistration()

// État de l'appareil ; `sub` (son abonnement local) n'est pas nul si et seulement si l'état vaut 'on'.
export async function pushState(): Promise<{ state: 'unsupported' | 'denied' | 'off' | 'on'; sub: PushSubscriptionJSON | null }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { state: 'unsupported', sub: null }
  if (Notification.permission === 'denied') return { state: 'denied', sub: null }
  const sub = await (await registration())?.pushManager.getSubscription()
  return sub ? { state: 'on', sub: sub.toJSON() } : { state: 'off', sub: null }
}

// null : « Bloquer » à l'invite (permission refusée), l'appelant montre l'état bloqué ; subscribe lèverait.
export async function subscribePush(vapidPublic: string): Promise<PushSubscriptionJSON | null> {
  // Premier appel du geste : Safari n'accorde la permission que pendant l'activation par l'utilisateur.
  if ((await Notification.requestPermission()) === 'denied') return null
  await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  // Jamais la registration de register() : au premier enregistrement, son worker est encore « installing », et Chromium refuse
  // subscribe (« no active Service Worker »).
  const reg = await navigator.serviceWorker.ready
  return (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(vapidPublic) })).toJSON()
}

// Désabonne le navigateur ; rend l'endpoint retiré, ou null sans abonnement.
export async function unsubscribePush(): Promise<string | null> {
  const sub = await (await registration())?.pushManager.getSubscription()
  if (!sub) return null
  await sub.unsubscribe()
  return sub.endpoint
}
