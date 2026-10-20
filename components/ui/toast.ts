// Message bref hors de React : il survit à la modale qui l'émet (défausse). Région role=status, donc aria-live polite.
export function toast(message: string, ms = 4000) {
  let region = document.getElementById('wm-toasts')
  if (!region) {
    region = document.createElement('div')
    region.id = 'wm-toasts'
    region.setAttribute('role', 'status')
    // Au-dessus de la barre basse sur mobile (R§6.3), en bas de l'écran dès md.
    region.className = 'pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6'
    document.body.append(region)
  }
  const el = document.createElement('p')
  el.className = 'card-frame motion-safe:animate-fade-in-up px-4 py-3 text-sm font-medium'
  el.textContent = message
  // Une région vide d'abord, le texte ensuite : certains lecteurs d'écran ignorent une région déjà remplie.
  const target = region
  setTimeout(() => target.append(el), 50)
  setTimeout(() => el.remove(), ms + 50)
}
