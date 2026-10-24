// Service worker du push (M4b-23), écrit à la main. Aucun gestionnaire fetch : rien n'est intercepté ni mis en cache.
// Neutre : le titre arrive dans la charge ({title, body, url, tag}, lib/push.ts, lib/brand.ts côté serveur) ; à défaut, un titre neutre,
// jamais la marque.

// Charge vide, non JSON ou sans titre : un titre neutre, jamais une exception (la notification serait perdue).
self.addEventListener('push', (event) => {
  let d = null
  try {
    d = event.data && event.data.json()
  } catch {}
  if (!d || typeof d !== 'object') d = {}
  const title = typeof d.title === 'string' && d.title ? d.title : 'Nouvelle notification'
  event.waitUntil(self.registration.showNotification(title, { body: d.body, tag: d.tag, icon: '/icon', data: { url: d.url } }))
})

// Un onglet de ce site déjà sur l'adresse prend le focus, sinon une fenêtre s'ouvre ; une adresse malformée ou d'une autre origine
// devient « / ».
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const origin = self.location.origin
  let href = `${origin}/`
  try {
    const url = new URL(event.notification.data?.url ?? '/', origin)
    if (url.origin === origin) href = url.href
  } catch {}
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    const tab = tabs.find((t) => t.url === href)
    return tab ? tab.focus() : self.clients.openWindow(href)
  }))
})
