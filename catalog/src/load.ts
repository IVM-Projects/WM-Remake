// Commande `load` : catalog-out (cards.csv, media.csv, counts.json) chargé dans la base par psql (pooler en mode session) —
// gardes de taille (M2-3), essai \copy et délai levé (M2-17), fusion par lots puis finalisation (M2-9), contrôle des parts.
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { RARITY } from '../../lib/rarity.ts'
import type { RarityCode } from '../../lib/rarity.ts'
import type { Counts, Mode } from './compute.ts'
import { CARD_CSV_COLUMNS, MEDIA_CSV_COLUMNS } from './emit.ts'

type Target = 'free' | 'pro'

// Supabase passe le plan Free en lecture seule à 500 Mo de cette somme : garde à 450 Mo (M2-3).
export const MAX_BYTES = 450e6
// shortcut: octets par carte (tas, index, pool, source, média) et par ligne de stage supposés, prudents ; remplacés par la mesure de la Task 13.
export const BYTES_PER_CARD = 2_000
export const STAGE_BYTES_PER_ROW = 1_500
export const SIZE_SQL = 'select sum(pg_database_size(datname))::bigint from pg_database'

// `<=` : une taille illisible (NaN) est refusée.
function guard(projection: number, target: Target): string | null {
  if (target === 'pro' || projection <= MAX_BYTES) return null
  return `Base trop pleine pour la cible ${target} : ${Math.round(projection)} octets projetés (limite ${MAX_BYTES})`
}

// Avant \copy : seul le stage est projeté ; les nouvelles cartes se comptent une fois le stage en base.
export const guardBeforeCopy = (size: number, rows: number, target: Target): string | null => guard(size + rows * STAGE_BYTES_PER_ROW, target)
export const guardAfterCopy = (size: number, newRows: number, target: Target): string | null => guard(size + newRows * BYTES_PER_CARD, target)
export const guardBatch = (size: number, target: Target): string | null => guard(size, target)

// Repli extracts : stats_v1 sans liens entrants (P11), à ne pas écrire sur les cartes tant que les statistiques ne sont pas gelées.
export const checkTextSource = (textSource: 'cirrus' | 'extracts', statsFrozen: boolean): string | null =>
  textSource === 'extracts' && !statsFrozen ? 'Statistiques dégradées : poser catalog_stats_frozen ou relancer avec cirrus' : null

// Parts en points de pourcentage ; relatif = écart / part du catalogue complet (Infinity pour une rareté absente du complet).
export function maxShareGap(pool: Record<RarityCode, number>, full: Record<RarityCode, number>): { points: number; relative: number } {
  const total = (c: Record<RarityCode, number>) => RARITY.reduce((s, r) => s + c[r.code], 0)
  const [p, f] = [total(pool), total(full)]
  let points = 0
  let relative = 0
  for (const { code } of RARITY) {
    const want = (100 * full[code]) / f
    const gap = Math.abs((100 * pool[code]) / p - want)
    points = Math.max(points, gap)
    relative = Math.max(relative, gap === 0 ? 0 : gap / want)
  }
  return { points, relative }
}

// Lecteur CSV minimal : un saut de ligne hors guillemets termine l'enregistrement ("" bascule deux fois, sans effet).
export async function firstCsvRecords(path: string, n: number): Promise<string> {
  let out = ''
  let quoted = false
  let records = -1 // l'en-tête termine l'enregistrement 0
  for await (const chunk of createReadStream(path, { encoding: 'utf8' }) as AsyncIterable<string>) {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === '"') quoted = !quoted
      else if (chunk[i] === '\n' && !quoted && ++records === n) return out + chunk.slice(0, i + 1)
    }
    out += chunk
  }
  return out
}

const run = promisify(execFile)

// Une session par appel, sans délai d'instruction (M2-17) ; une ligne par résultat. Le message d'erreur d'execFile cite la
// ligne de commande, donc l'URL : seule la sortie d'erreur de psql remonte.
async function psql(db: string, ...commands: string[]): Promise<string[]> {
  try {
    const { stdout } = await run('psql', [db, '-qAtX', '-v', 'ON_ERROR_STOP=1', '-c', 'set statement_timeout = 0', ...commands.flatMap((c) => ['-c', c])])
    return stdout.split('\n').slice(0, -1)
  } catch (err) {
    const e = err as { stderr?: string; code?: unknown }
    throw new Error(`psql : ${e.stderr?.trim() || String(e.code)}`)
  }
}

// Nom de fichier entre apostrophes pour \copy, apostrophe doublée.
const copy = (table: string, columns: readonly string[], file: string) =>
  `\\copy ${table} (${columns.join(', ')}) from '${file.replaceAll("'", "''")}' with (format csv, header true)`
// Les trois tables partout où le stage est vidé : un résultat resté d'un chargement interrompu ferait sauter sa page (M2-R4).
const TRUNCATE = 'truncate wm.catalog_stage, wm.catalog_stage_media, wm.catalog_stage_result'
const log = (line: string) => console.error(line)

export async function loadCommand(o: { dir: string; mode: Mode; target: Target; db: string; batch?: number }): Promise<Record<string, unknown>> {
  const counts = JSON.parse(await readFile(join(o.dir, 'counts.json'), 'utf8')) as Counts & { text_source: 'cirrus' | 'extracts'; cards: number }
  // Artefacts d'un autre run possibles (artifacts_run_id).
  if (counts.mode !== o.mode) throw new Error(`Mode ${o.mode} différent de celui de catalog-out (${counts.mode})`)
  const [statsFrozen, size0, walOk] = await psql(o.db, "select value from wm.config where key = 'catalog_stats_frozen'", SIZE_SQL,
    "select has_function_privilege('pg_ls_waldir()', 'execute')")
  log(`base avant chargement : ${size0} octets`)
  const refused = checkTextSource(counts.text_source, statsFrozen === 'true') ?? guardBeforeCopy(Number(size0), counts.cards, o.target)
  if (refused) throw new Error(refused)

  // Essai de 10 lignes (le passage de \copy par le pooler n'est pas vérifié, M2-17) sur un stage vidé : sinon 23505.
  const cards = resolve(o.dir, 'cards.csv')
  const tmp = await mkdtemp(join(tmpdir(), 'wm-load-'))
  const probe = join(tmp, 'probe.csv')
  const [probed] = await writeFile(probe, await firstCsvRecords(cards, 10))
    .then(() => psql(o.db, TRUNCATE, copy('wm.catalog_stage', CARD_CSV_COLUMNS, probe), 'select count(*) from wm.catalog_stage', TRUNCATE))
    .finally(() => rm(tmp, { recursive: true, force: true }))
  if (Number(probed) !== Math.min(10, counts.cards)) throw new Error(`Essai \\copy : ${probed} lignes au lieu de 10`)
  log(`essai \\copy : ${probed} lignes`)

  const [size1, staged, fresh] = await psql(o.db, copy('wm.catalog_stage', CARD_CSV_COLUMNS, cards),
    copy('wm.catalog_stage_media', MEDIA_CSV_COLUMNS, resolve(o.dir, 'media.csv')), SIZE_SQL, 'select count(*) from wm.catalog_stage',
    'select count(*) from wm.catalog_stage s where not exists (select from wm.card_source x where x.page_id = s.page_id)')
  log(`stage : ${staged} lignes dont ${fresh} nouvelles, base ${size1} octets`)
  const full = guardAfterCopy(Number(size1), Number(fresh), o.target)
  if (full) {
    await psql(o.db, TRUNCATE)
    throw new Error(full)
  }

  // Un lot par transaction ; arrêt sur la garde : le stage reste inachevé, le chargement suivant le vide.
  const wal = walOk === 't' ? ['select sum(size) from pg_ls_waldir()'] : []
  for (;;) {
    const [merged, size, walBytes] = await psql(o.db, `select wm.catalog_merge('${o.mode}', ${o.batch ?? 10_000})`, SIZE_SQL, ...wal)
    const m = JSON.parse(merged) as { processed: number; frozen: boolean }
    if (m.frozen) {
      await psql(o.db, TRUNCATE)
      log('Catalogue gelé : rien chargé')
      return { frozen: true }
    }
    if (m.processed === 0) break
    log(`lot de ${m.processed} pages : base ${size} octets${walBytes ? `, WAL ${walBytes} octets` : ''}`)
    const over = guardBatch(Number(size), o.target)
    if (over) throw new Error(over)
  }

  const [finalized] = await psql(o.db, `select wm.catalog_finalize('${o.mode}')`)
  const summary = JSON.parse(finalized) as Record<string, unknown> & { pool: Record<RarityCode, number> }
  const [size2] = await psql(o.db, 'vacuum (analyze) public.cards, wm.draw_pool, wm.card_source, wm.card_media', SIZE_SQL)
  log(`base après chargement : ${size2} octets`)
  const gap = maxShareGap(summary.pool, counts.full)
  if (gap.points > 1) throw new Error(`Parts de rareté hors tolérance : ${gap.points.toFixed(2)} points`)
  return { ...summary, share_gap: gap }
}
