// Vues mensuelles `user` de pageview_complete (lignes `fr.wikipedia …`) → views.tsv.
import { join } from 'node:path'
import { writeTsv } from './tsv.ts'
import type { Field } from './tsv.ts'

const ACCESS = new Set(['desktop', 'mobile-web', 'mobile-app'])
const COUNT = /^\d+$/

// Ligne : `wiki titre page_id|null accès total compteurs` ; 5 champs sans page_id (KNOWN ISSUE du readme des dumps).
export async function pageviewsCommand(o: {
  input: AsyncIterable<string>
  dir: string
  minLines?: number
}): Promise<{ lines: number; malformed: number }> {
  const minLines = o.minLines ?? 2_000_000
  const byId = new Map<number, number>()
  const byTitle = new Map<string, number>()
  let lines = 0
  let malformed = 0
  for await (const line of o.input) {
    const f = line.split(' ')
    if (f[0] !== 'fr.wikipedia') continue
    lines++
    if (f.length === 5) f.splice(2, 0, 'null')
    const [, title, id, access, total] = f
    if (f.length !== 6 || !title || !(id === 'null' || COUNT.test(id)) || !ACCESS.has(access) || !COUNT.test(total)) {
      malformed++
      continue
    }
    if (id === 'null') byTitle.set(title, (byTitle.get(title) ?? 0) + Number(total))
    else byId.set(Number(id), (byId.get(Number(id)) ?? 0) + Number(total))
  }
  if (lines < minLines) throw new Error(`Format des vues inattendu : ${lines} lignes (${minLines} attendues au moins)`)
  if (malformed > lines / 100) throw new Error(`Format des vues inattendu : ${malformed} lignes mal formées sur ${lines}`)

  // views.tsv : page_id|\N, title|\N, views ; d'abord une ligne par page_id (title \N, somme des accès),
  // puis une par titre des lignes sans page_id (page_id \N).
  function* rows(): Generator<Field[]> {
    for (const [id, views] of byId) yield [id, null, views]
    for (const [title, views] of byTitle) yield [null, title, views]
  }
  await writeTsv(join(o.dir, 'views.tsv'), rows())
  return { lines, malformed }
}
