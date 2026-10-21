import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, expect, test } from 'vitest'
import { dumpsCommand, openLines, sqlTuples } from './sqldump.ts'
import { dump, PAGE_CREATE, PAGE_TUPLES, PROPS_CREATE, PROPS_TUPLES } from './sqldump.sample.ts'
import { readTsv } from './tsv.ts'

const dir = await mkdtemp(join(tmpdir(), 'wm-sqldump-'))
afterAll(() => rm(dir, { recursive: true, force: true }))

async function* lines(text: string) {
  yield* text.split('\n')
}

const tuples = (text: string, table: 'page' | 'page_props' = 'page') => Array.fromAsync(sqlTuples(lines(text), table))

test('dumps : pages de l’espace 0 hors redirections, propriétés utiles par page', async () => {
  const page = join(dir, 'page.sql')
  const props = join(dir, 'page_props.sql')
  await writeFile(page, dump('page', PAGE_CREATE, PAGE_TUPLES))
  await writeFile(props, dump('page_props', PROPS_CREATE, PROPS_TUPLES))
  expect(await dumpsCommand({ page, props, dir })).toEqual({ pages: 2, props: 6 })
  expect(await Array.fromAsync(readTsv(join(dir, 'pages.tsv')))).toEqual([
    ['3', 'Antoine_Meillet', '16467'],
    ['16', "Arc_de_triomphe_de_l'Étoile", '67657'],
  ])
  // page_id, image, qid, badge, disambig ; 50 (page_image non libre) et 1264 ne donnent rien.
  expect(await Array.fromAsync(readTsv(join(dir, 'props.tsv')))).toEqual([
    ['11', 'Palacio_del_Congreso_in_Buenos_Aires_(6370115601).jpg', 'Q1154647', '0', '0'],
    ['12', "Hogan's_Flying_Column.gif", null, '0', '0'],
    ['18', null, null, '1', '0'],
    ['48', null, null, '0', '1'],
    ['49', null, null, '0.6', '0'],
    ['60', null, null, '1', '0'],
  ])
})

test('les mêmes tuples sur une seule ligne, et gzippés, donnent le même résultat', async () => {
  const multi = await tuples(dump('page', PAGE_CREATE, PAGE_TUPLES))
  expect(multi[0]).toEqual([3, 0, 'Antoine_Meillet', 0, 0, 0.792197141602819, '20260930180248', '20260930205913', 235942045, 16467, 'wikitext', null])
  expect(await tuples(dump('page', PAGE_CREATE, PAGE_TUPLES, true))).toEqual(multi)

  const gz = join(dir, 'one-line.sql.gz')
  const props = join(dir, 'empty_props.sql')
  await writeFile(gz, gzipSync(dump('page', PAGE_CREATE, PAGE_TUPLES, true)))
  await writeFile(props, dump('page_props', PROPS_CREATE, [String.raw`(1264,'kartographer_links','1',1)`]))
  const out = join(dir, 'gz')
  await mkdir(out)
  expect(await dumpsCommand({ page: gz, props, dir: out })).toEqual({ pages: 2, props: 0 })
  expect(await Array.fromAsync(readTsv(join(out, 'pages.tsv')))).toEqual([
    ['3', 'Antoine_Meillet', '16467'],
    ['16', "Arc_de_triomphe_de_l'Étoile", '67657'],
  ])
})

test('échappements MySQL dans une chaîne', async () => {
  const [row] = await tuples(dump('page', PAGE_CREATE, [String.raw`(5,0,'a\\b\"c\nd\0',0,0,0.5,'20260930180248',NULL,1,10,'wikitext',NULL)`]))
  expect(row[2]).toBe('a\\b"c\nd\0')
})

test('format inattendu : colonnes, nombre de valeurs, table absente, dump tronqué', async () => {
  const renamed = PAGE_CREATE.map((l) => l.replace('`page_len`', '`page_length`'))
  await expect(tuples(dump('page', renamed, PAGE_TUPLES))).rejects.toThrow(
    'Colonnes inattendues pour page : page_id, page_namespace, page_title, page_is_redirect, page_is_new, page_random, page_touched, page_links_updated, page_latest, page_length, page_content_model, page_lang',
  )
  const eleven = String.raw`(3,0,'Antoine_Meillet',0,0,0.792197141602819,'20260930180248','20260930205913',235942045,16467,'wikitext')`
  await expect(tuples(dump('page', PAGE_CREATE, [eleven]))).rejects.toThrow('Tuple de 11 valeurs pour page (12 attendues)')
  await expect(tuples(dump('page_props', PROPS_CREATE, PROPS_TUPLES))).rejects.toThrow('CREATE TABLE absent pour page')
  const cut = dump('page', PAGE_CREATE, PAGE_TUPLES).split('\n').slice(0, -3).join('\n')
  await expect(tuples(cut)).rejects.toThrow('Dump tronqué pour page')
})

test('INSERT d’une autre forme pour la table, nombre non décimal', async () => {
  const head = dump('page', PAGE_CREATE, []).split('INSERT')[0]
  const withColumns = `${head}INSERT INTO \`page\` (\`page_id\`) VALUES (3);\n`
  await expect(tuples(withColumns)).rejects.toThrow('Format INSERT inattendu pour page')
  await expect(tuples(`${head}INSERT IGNORE INTO \`page\` VALUES ${PAGE_TUPLES[0]};\n`)).rejects.toThrow('Format INSERT inattendu pour page')
  for (const bad of ['0x1F', 'Infinity', '1e', '+1']) {
    const tuple = PAGE_TUPLES[0].replace(',16467,', `,${bad},`)
    await expect(tuples(dump('page', PAGE_CREATE, [tuple]))).rejects.toThrow(`Valeur inattendue pour page : ${bad}`)
  }
  const ok = PAGE_TUPLES[0].replace(',16467,', ',-1.5e+3,')
  expect((await tuples(dump('page', PAGE_CREATE, [ok])))[0][9]).toBe(-1500)
})

// Assez de tuples pour que zlib n'ait pas fini de lire quand le parseur lève (2 000 tuples, octet à 30 %).
const bigDump = (create: string[]) =>
  dump('page', create, Array.from({ length: 2000 }, (_, i) => PAGE_TUPLES[0].replace('(3,', `(${i},`).replace('16467', String((i * 2654435761) % 1e9))))

test('gzip tronqué : erreur propre', async () => {
  const gz = gzipSync(bigDump(PAGE_CREATE))
  const path = join(dir, 'truncated.sql.gz')
  await writeFile(path, gz.subarray(0, gz.length - 100))
  await expect(Array.fromAsync(sqlTuples(openLines(path), 'page'))).rejects.toThrow('unexpected end of file')
})

test('gzip corrompu après une erreur du parseur : flux fermés, aucune erreur non gérée', async () => {
  const gz = gzipSync(bigDump(PAGE_CREATE.map((l) => l.replace('`page_len`', '`page_length`'))))
  gz[Math.floor(gz.length * 0.3)] ^= 0xff
  const path = join(dir, 'corrupt.sql.gz')
  await writeFile(path, gz)
  await expect(Array.fromAsync(sqlTuples(openLines(path), 'page'))).rejects.toThrow('Colonnes inattendues pour page')
  // Laisse à zlib le temps d'atteindre l'octet corrompu : sans fermeture, son 'error' sans écouteur fait tomber le processus.
  await new Promise((resolve) => setTimeout(resolve, 200))
})
