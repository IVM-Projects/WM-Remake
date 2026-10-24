// Avatar d'un joueur, à côté de son pseudo : décoratif, alt vide (D:753). Miniature Commons en lien direct, sans l'optimiseur de Next
// (D§8.5) ; sans image, l'initiale. lg : 96 px (profils), sm : 40 px (/dms).
export function Avatar({ url, name, size }: { url: string | null; name: string; size: 'lg' | 'sm' }) {
  const box = size === 'lg' ? 'size-24 text-4xl' : 'size-10'
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className={`${box} shrink-0 rounded-full object-cover`} />
  ) : (
    <span aria-hidden="true" className={`inline-flex ${box} shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-light)] font-bold text-[var(--color-accent)]`}>
      {[...name][0]?.toUpperCase()}
    </span>
  )
}
