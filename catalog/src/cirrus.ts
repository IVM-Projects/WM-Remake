// Dump CirrusSearch hebdomadaire de frwiki_content (M2-5) : instantané et parts (les documents arrivent à la Task 6).
import { USER_AGENT } from './http.ts'

const ROOT = 'https://dumps.wikimedia.org/other/cirrus_search_index/'

// Un dossier encore absent (404) se lit comme vide : l'instantané en cours d'écriture est sauté.
async function fetchDumpText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 404) return ''
  if (!res.ok) throw new Error(`Cirrus : HTTP ${res.status} sur ${url}`)
  return res.text()
}

// Le plus récent dossier `YYYYMMDD/` dont `index_name=frwiki_content/` contient `_SUCCESS` ; parts triées.
export async function cirrusListing(
  fetchText: (url: string) => Promise<string> = fetchDumpText,
): Promise<{ date: string; parts: string[] }> {
  const dates = [...new Set((await fetchText(ROOT)).matchAll(/href="(\d{8})\/"/g).map((m) => m[1]))].sort().reverse()
  for (const date of dates) {
    const html = await fetchText(`${ROOT}${date}/index_name%3Dfrwiki_content/`)
    const parts = new RegExp(`href="(frwiki_content-${date}-\\d{5}\\.json\\.bz2)"`, 'g')
    const names = [...new Set(html.matchAll(parts).map((m) => m[1]))].sort()
    if (html.includes('href="_SUCCESS"') && names.length > 0) return { date, parts: names }
  }
  throw new Error('Cirrus : aucun instantané complet de frwiki_content')
}
