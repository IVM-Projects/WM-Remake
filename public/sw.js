// Service worker du push (M4b-23), écrit à la main. Aucun gestionnaire fetch : rien n'est intercepté ni mis en cache.
// Neutre : le titre arrive dans la charge ({title, body, url, tag}, lib/push.ts), jamais écrit ici.

self.addEventListener('push', (event) => {
  const d = event.data ? event.data.json() : {}
  event.waitUntil(self.registration.showNotification(d.title, { body: d.body, tag: d.tag, icon: '/icon', data: { url: d.url } }))
})

// Un onglet de ce site déjà sur l'adresse prend le focus, sinon une fenêtre s'ouvre ; une adresse d'une autre origine devient « / ».
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const origin = self.location.origin
  const url = new URL(event.notification.data?.url ?? '/', origin)
  const href = url.origin === origin ? url.href : `${origin}/`
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    const tab = tabs.find((t) => t.url === href)
    return tab ? tab.focus() : self.clients.openWindow(href)
  }))
})
