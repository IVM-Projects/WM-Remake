// Commons (et frwiki pour les fichiers locaux) : imageinfo + extmetadata des images retenues (parseur à la Task 7).
import { batchUrls } from './http.ts'

const imageInfoBase = (host: string) =>
  `https://${host}/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=330&iiextmetadatafilter=Artist|Attribution|LicenseShortName|LicenseUrl&iiextmetadatalanguage=fr&titles=`

// Règles de lots : noms (sans préfixe, avec `_`) dédoublonnés, ordre des unités de code, 50 par appel, URL ≤ 7 000 caractères.
export function imageInfoUrls(files: string[], host: 'commons.wikimedia.org' | 'fr.wikipedia.org'): string[] {
  return batchUrls(imageInfoBase(host), [...new Set(files)].sort().map((f) => `File:${f}`), 50, 7000)
}

type Page = { title?: string; missing?: boolean; invalid?: boolean; imageinfo?: unknown }
type Body = { query?: { normalized?: { from: string; to: string }[]; pages?: Page[] } }

// Fichiers manquants ou invalides, sous la forme demandée (`query.normalized` : to → from, préfixe retiré).
// Un fichier partagé vu depuis frwiki porte `missing` mais a son imageinfo : il n'est pas manquant.
export function missingFiles(body: unknown): string[] {
  const query = (body as Body | null)?.query
  const asked = new Map((query?.normalized ?? []).map((n) => [n.to, n.from]))
  return (query?.pages ?? []).flatMap((p) => {
    if (!(p.missing || p.invalid) || p.imageinfo !== undefined || p.title === undefined) return []
    const title = asked.get(p.title) ?? p.title
    return [title.slice(title.indexOf(':') + 1)]
  })
}
