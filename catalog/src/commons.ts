// Commons (et frwiki pour les fichiers locaux) : imageinfo + extmetadata des images retenues, miniatures 330 px,
// auteur et licence en texte brut (M2-6, P5, P15), reprenables par lots.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { batchUrls, batchValues, deadline, fetchBatches } from './http.ts'
import type { Client } from './http.ts'
import { readTsv, writeTsv } from './tsv.ts'

const imageInfoBase = (host: string) =>
  `https://${host}/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=330&iiextmetadatafilter=Artist|Attribution|LicenseShortName|LicenseUrl&iiextmetadatalanguage=fr&titles=`

// Règles de lots : noms (sans préfixe, avec `_`) dédoublonnés, ordre des unités de code, 50 par appel, URL ≤ 7 000 caractères.
export function imageInfoUrls(files: string[], host: 'commons.wikimedia.org' | 'fr.wikipedia.org'): string[] {
  return batchUrls(imageInfoBase(host), [...new Set(files)].sort().map((f) => `File:${f}`), 50, 7000)
}

type Meta = Record<string, { value?: unknown } | undefined>
type Info = { url?: string; width: number; mime: string; extmetadata?: Meta }
type Page = { title?: string; missing?: boolean; invalid?: boolean; imagerepository?: string; imageinfo?: Info[] }
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

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' }

// Texte brut d'un champ HTML d'extmetadata. Le texte masqué (`display: none`, modèle {{Unknown}}) est retiré et une
// balise de bloc compte pour un blanc, sinon « Auteur inconnuUnknown author ».
export function stripHtml(html: string): string {
  return html
    .replace(/<(\w+)[^>]*display:\s*none[^>]*>[^<]*<\/\1>/gi, '')
    .replace(/<\/?(?:br|p|div|li|ul|ol|dd|dt|tr|td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec?: string, hex?: string, name?: string) => {
      const code = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : undefined
      if (code === undefined) return NAMED[name!] ?? m
      return code <= 0x10ffff ? String.fromCodePoint(code) : m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

// Miniature de 330 px (M2-6, P5) : chemin md5 du nom avec `_`, `.png` ajouté pour un SVG ; une image matricielle de
// 330 px ou moins donne l'original (MediaWiki n'agrandit pas) ; un nom de plus de 160 octets devient `thumbnail.<ext>`.
// shortcut: formats paginés (TIFF, PDF, DjVu) et autres types sans miniature → null, à traiter si leur part compte.
export function thumbUrl(file: string, o: { repo: 'commons' | 'fr'; mime: string; width: number }): string | null {
  const svg = o.mime === 'image/svg+xml'
  if (!svg && !RASTER.has(o.mime)) return null
  const name = file.replaceAll(' ', '_')
  const md5 = createHash('md5').update(name).digest('hex')
  const base = `https://upload.wikimedia.org/wikipedia/${o.repo}`
  const path = `${md5[0]}/${md5.slice(0, 2)}/${encodeURIComponent(name)}`
  if (!svg && o.width <= 330) return `${base}/${path}`
  const thumb = Buffer.byteLength(name) > 160 ? `thumbnail.${name.slice(name.lastIndexOf('.') + 1).toLowerCase()}` : encodeURIComponent(name)
  return `${base}/thumb/${path}/330px-${thumb}${svg ? '.png' : ''}`
}

export type Media = { file: string; author: string | null; license: string | null; license_url: string | null; image_url: string | null }

function metaText(meta: Meta | undefined, key: string): string | null {
  const value = meta?.[key]?.value
  return typeof value === 'string' ? stripHtml(value) || null : null
}

// Médias des pages qui ont un imageinfo (noms sous la forme demandée) et fichiers manquants. `repo` = wiki interrogé :
// un fichier `local` y est, un fichier `shared` est sur Commons.
export function parseImageInfo(body: unknown, repo: 'commons' | 'fr'): { media: Media[]; missing: string[] } {
  const query = (body as Body | null)?.query
  const asked = new Map((query?.normalized ?? []).map((n) => [n.to, n.from]))
  const media = (query?.pages ?? []).flatMap((p): Media[] => {
    const info = p.imageinfo?.[0]
    if (info === undefined || p.title === undefined) return []
    const title = asked.get(p.title) ?? p.title
    const meta = info.extmetadata
    const licenseUrl = meta?.LicenseUrl?.value
    // Nom tiré de `url` : pour une redirection de fichier, imageinfo est celui de la cible.
    const name = info.url && decodeURIComponent(info.url.split('?')[0].split('/').pop()!)
    const at = p.imagerepository === 'shared' ? 'commons' : repo
    return [{
      file: title.slice(title.indexOf(':') + 1),
      author: metaText(meta, 'Attribution') ?? metaText(meta, 'Artist'),
      license: metaText(meta, 'LicenseShortName'),
      // Devient un href : http(s) seulement (P15).
      license_url: typeof licenseUrl === 'string' && /^https?:\/\//.test(licenseUrl) ? licenseUrl : null,
      image_url: name ? thumbUrl(name, { repo: at, mime: info.mime, width: info.width }) : null,
    }]
  })
  return { media, missing: missingFiles(body) }
}

const names = (url: string) => batchValues(url).map((v) => v.slice('File:'.length))

// media.tsv : file, author|\N, license|\N, license_url|\N, image_url|\N ; écrit en ajout lot par lot. Commons d'abord,
// puis frwiki pour l'union des fichiers absents de Commons ; introuvable partout → ligne `file` seule (\N ailleurs).
// Un lot Commons dont chaque fichier y est déjà est sauté ; celui qui attend encore frwiki est redemandé.
export async function commonsCommand(o: {
  dir: string
  client: Client
  deadlineMin?: number
  now?: () => number
}): Promise<{ done: number; skipped: number; finished: boolean }> {
  const files: string[] = []
  // catalog.tsv : image en colonne 6, selected en colonne 9.
  for await (const f of readTsv(join(o.dir, 'catalog.tsv'))) if (f[8] === '1' && f[5] !== null) files.push(f[5])
  const path = join(o.dir, 'media.tsv')
  const written = new Set<string>()
  if (existsSync(path)) for await (const f of readTsv(path)) written.add(String(f[0]))
  async function write(media: Media[]) {
    const fresh = media.filter((m) => !written.has(m.file))
    for (const m of fresh) written.add(m.file)
    await writeTsv(path, fresh.map((m) => [m.file, m.author, m.license, m.license_url, m.image_url]), { append: true })
  }

  const late = deadline(o)
  const urls = imageInfoUrls(files, 'commons.wikimedia.org')
  const todo = urls.filter((url) => !names(url).every((f) => written.has(f)))
  const asked: string[] = []
  const missing: string[] = []
  let done = 0
  let finished = await fetchBatches(o.client, todo, late, async (url, body) => {
    done++
    const r = parseImageInfo(body, 'commons')
    asked.push(...names(url))
    missing.push(...r.missing)
    await write(r.media)
  })
  if (finished) {
    const local = imageInfoUrls(missing.filter((f) => !written.has(f)), 'fr.wikipedia.org')
    finished = await fetchBatches(o.client, local, late, async (_, body) => {
      done++
      await write(parseImageInfo(body, 'fr').media)
    })
  }
  // Ligne vide pour l'introuvable (manquant, invalide ou sans imageinfo) : son lot n'est plus redemandé.
  if (finished) await write(asked.map((file) => ({ file, author: null, license: null, license_url: null, image_url: null })))
  return { done, skipped: urls.length - todo.length, finished }
}
