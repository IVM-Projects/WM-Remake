// Dump CirrusSearch hebdomadaire de frwiki_content (M2-5) : instantané et parts (les documents arrivent à la Task 6).
import { USER_AGENT } from './http.ts'

const ROOT = 'https://dumps.wikimedia.org/other/cirrus_search_index/'

// 3 essais à 5 s d'intervalle sur une erreur réseau ou un 5xx ; 404 → null (dossier absent).
async function fetchDumpText(url: string): Promise<string | null> {
  let failure = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5000))
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
      if (res.ok) return await res.text()
    } catch {
      failure = 'réseau'
      continue
    }
    if (res.status === 404) return null
    if (res.status < 500) throw new Error(`Cirrus : HTTP ${res.status} sur ${url}`)
    failure = `HTTP ${res.status}`
  }
  throw new Error(`Cirrus : ${failure} sur ${url} après 3 essais`)
}

// Le plus récent dossier `YYYYMMDD/` dont `index_name=frwiki_content/` contient `_SUCCESS` ; parts triées.
// Un dossier en 404 (instantané en cours d'écriture) est sauté ; un listing racine en 404 est une erreur.
export async function cirrusListing(
  fetchText: (url: string) => Promise<string | null> = fetchDumpText,
): Promise<{ date: string; parts: string[] }> {
  const root = await fetchText(ROOT)
  if (root === null) throw new Error(`Cirrus : listing des dumps introuvable sur ${ROOT}`)
  const dates = [...new Set(root.matchAll(/href="(\d{8})\/"/g).map((m) => m[1]))].sort().reverse()
  for (const date of dates) {
    const html = (await fetchText(`${ROOT}${date}/index_name%3Dfrwiki_content/`)) ?? ''
    const parts = new RegExp(`href="(frwiki_content-${date}-\\d{5}\\.json\\.bz2)"`, 'g')
    const names = [...new Set(html.matchAll(parts).map((m) => m[1]))].sort()
    if (html.includes('href="_SUCCESS"') && names.length > 0) return { date, parts: names }
  }
  throw new Error('Cirrus : aucun instantané complet de frwiki_content')
}
