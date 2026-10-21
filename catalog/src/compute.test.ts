import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { RARITY } from '../../lib/rarity.ts'
import type { RarityCode } from '../../lib/rarity.ts'
import {
  cleanOpening,
  cutSummary,
  fnv1a32,
  hasOpening,
  joinCatalog,
  pct,
  selectCommand,
  selectSample,
  statsV1,
} from './compute.ts'
import type { CatalogRow, Counts } from './compute.ts'
import { readTsv, writeTsv } from './tsv.ts'
import type { Field } from './tsv.ts'

const root = await mkdtemp(join(tmpdir(), 'wm-compute-'))
afterAll(() => rm(root, { recursive: true, force: true }))

test('fnv1a32 : valeurs de référence FNV-1a 32 bits', () => {
  expect(fnv1a32('')).toBe(2166136261)
  expect(fnv1a32('a')).toBe(3826002220)
  expect(fnv1a32('foobar')).toBe(3214735720)
})

test('pct : rang percentile, ex æquo au rang moyen, n = 1 → 0,5', () => {
  expect(pct([10, 20, 20, 30])).toEqual([0, 0.5, 0.5, 1])
  expect(pct([30, 10, 20, 20])).toEqual([1, 0, 0.5, 0.5])
  expect(pct([7])).toEqual([0.5])
  expect(pct([])).toEqual([])
  // Un NaN rend le comparateur du tri incohérent et désordonne toutes les valeurs.
  expect(() => pct([3, NaN, 1, 2])).toThrow('pct : valeur non finie')
  expect(() => pct([1, Infinity])).toThrow('pct : valeur non finie')
})

test('statsV1 : q_score, ATK et DEF (D§10.1)', () => {
  const s = statsV1([
    { text_bytes: 100, incoming_links: 0, badge: 0 },
    { text_bytes: 200, incoming_links: 5, badge: 0.6 },
    { text_bytes: 300, incoming_links: 5, badge: 1 },
  ])
  expect(s.map((r) => r.q_score)).toEqual([0, 60.75, 91.25])
  expect(s.map((r) => r.atk)).toEqual([1000, 5500, 10000])
  expect(s.map((r) => r.def)).toEqual([1000, 5500, 10000])
})

const row = (page_id: number, rarity: RarityCode): CatalogRow => ({
  page_id, title: `P${page_id}`, len: 1, views: 0, rarity, image: null, qid: null, badge: 0, selected: false,
})

// Dixième des comptes du R§ ; page_id 1..N.
const TENTH: Record<RarityCode, number> = { L: 176, UR: 1237, SR: 6679, R: 17966, PC: 51676, C: 199613 }
function synthetic(counts: Partial<Record<RarityCode, number>>): CatalogRow[] {
  const rows: CatalogRow[] = []
  for (const { code } of RARITY) for (let i = 0; i < (counts[code] ?? 0); i++) rows.push(row(rows.length + 1, code))
  return rows
}

test('selectSample : quota exact par rareté, parts à 1 point près, stable', () => {
  const rows = synthetic(TENTH)
  const keep = selectSample(rows, 0.09)
  const kept: Record<string, number> = {}
  for (const r of rows) if (keep.has(r.page_id)) kept[r.rarity] = (kept[r.rarity] ?? 0) + 1
  expect(kept).toEqual({ L: 16, UR: 111, SR: 601, R: 1617, PC: 4651, C: 17965 })

  const total = rows.length
  for (const { code } of RARITY) expect(Math.abs(kept[code] / keep.size - TENTH[code] / total) * 100).toBeLessThanOrEqual(1)

  expect([...selectSample(rows, 0.09)]).toEqual([...keep])
  expect(selectSample(rows, 1).size).toBe(total)
})

test('selectSample : une rareté de 3 pages garde 1 page', () => {
  const rows = synthetic({ L: 3, C: 1000 })
  const keep = selectSample(rows, 0.09)
  expect(rows.filter((r) => r.rarity === 'L' && keep.has(r.page_id))).toHaveLength(1)
  expect(rows.filter((r) => r.rarity === 'C' && keep.has(r.page_id))).toHaveLength(90)
})

let n = 0
async function catalogDir(over: Partial<Record<'pages.tsv' | 'props.tsv' | 'views.tsv', Field[][]>> = {}) {
  const dir = await mkdtemp(join(root, `${n++}-`))
  const files = {
    'pages.tsv': [
      [1, 'Chat', 1000],
      [2, 'Chat_(homonymie)', 200],
      [3, 'Chien', 500],
      [4, 'Oiseau', 300],
    ],
    'props.tsv': [
      [1, 'Chat.jpg', 'Q146', 1, 0],
      [2, null, 'Q1', 0, 1],
      [3, null, null, 0.6, 0],
    ],
    'views.tsv': [
      [1, null, 245],
      [2, null, 99999],
      [null, 'Chat', 5],
      [null, 'Inconnu', 7],
    ],
    ...over,
  }
  for (const [name, rows] of Object.entries(files)) await writeTsv(join(dir, name), rows)
  return dir
}

// 245 vues par id seules donneraient PC : la ligne par titre fait passer le seuil inclus de R.
test('joinCatalog : homonymie exclue, vues par id + par titre, propriétés reportées', async () => {
  const rows = await joinCatalog(await catalogDir())
  expect(rows).toEqual([
    { page_id: 1, title: 'Chat', len: 1000, views: 250, rarity: 'R', image: 'Chat.jpg', qid: 'Q146', badge: 1, selected: false },
    { page_id: 3, title: 'Chien', len: 500, views: 0, rarity: 'C', image: null, qid: null, badge: 0.6, selected: false },
    { page_id: 4, title: 'Oiseau', len: 300, views: 0, rarity: 'C', image: null, qid: null, badge: 0, selected: false },
  ])
})

test('joinCatalog : une ligne tronquée ou un nombre mal formé arrête la jointure', async () => {
  const run = async (over: Parameters<typeof catalogDir>[0]) => joinCatalog(await catalogDir(over))
  await expect(run({ 'pages.tsv': [[1, 'Chat', 1000], [5, 'Truc']] })).rejects.toThrow(
    'Nombre attendu dans pages.tsv, ligne 2, colonne 3 : (absent)',
  )
  await expect(run({ 'pages.tsv': [['x', 'Chat', 1000]] })).rejects.toThrow('Nombre attendu dans pages.tsv, ligne 1, colonne 1 : x')
  await expect(run({ 'views.tsv': [[1, null, 245], [null, 'Chat', 'abc']] })).rejects.toThrow(
    'Nombre attendu dans views.tsv, ligne 2, colonne 3 : abc',
  )
  await expect(run({ 'views.tsv': [[1, null, null]] })).rejects.toThrow('Nombre attendu dans views.tsv, ligne 1, colonne 3 : \\N')
  await expect(run({ 'props.tsv': [[1, 'Chat.jpg', 'Q146', 1]] })).rejects.toThrow(
    'Nombre attendu dans props.tsv, ligne 1, colonne 5 : (absent)',
  )
  // Nombres stricts (comme le parseur du dump) : ni blanc, ni hexadécimal ; page_id et badge de props.tsv, page_id de views.tsv.
  await expect(run({ 'pages.tsv': [[' ', 'Chat', 1000]] })).rejects.toThrow('Nombre attendu dans pages.tsv, ligne 1, colonne 1 :  ')
  await expect(run({ 'props.tsv': [['0x1F', 'Chat.jpg', 'Q146', 1, 0]] })).rejects.toThrow(
    'Nombre attendu dans props.tsv, ligne 1, colonne 1 : 0x1F',
  )
  await expect(run({ 'props.tsv': [[1, 'Chat.jpg', 'Q146', 'oui', 0]] })).rejects.toThrow(
    'Nombre attendu dans props.tsv, ligne 1, colonne 4 : oui',
  )
  await expect(run({ 'views.tsv': [['un', null, 245]] })).rejects.toThrow('Nombre attendu dans views.tsv, ligne 1, colonne 1 : un')
})

test('cleanOpening : bandeaux de tête retirés, espaces réduits', () => {
  expect(cleanOpening('Pour les articles homonymes, voir Chat (homonymie). Le chat est un mammifère.')).toBe(
    'Le chat est un mammifère.',
  )
  const banners = [
    'Pour les articles homonymes, voir X.',
    "Pour l'article homonyme, voir X.",
    'Pour l’article homonyme, voir X.',
    'Pour les articles ayant des titres homonymes, voir X.',
    'Ne doit pas être confondu avec Y.',
    'Ne pas confondre avec Z.',
    'Cet article concerne l’animal.',
    'Pour un article plus général, voir Félins.',
    '« Minou » redirige ici.',
  ]
  expect(cleanOpening(`${banners.join(' ')} Le chat est un mammifère.`)).toBe('Le chat est un mammifère.')
  for (const b of banners) expect(cleanOpening(b)).toBe('')
  expect(cleanOpening('  Le   chat\n est  un mammifère.  ')).toBe('Le chat est un mammifère.')
  expect(cleanOpening('Le chat est un mammifère. Ne pas confondre avec le lynx.')).toBe(
    'Le chat est un mammifère. Ne pas confondre avec le lynx.',
  )
  // Point dans un titre entre guillemets : le bandeau finit après le « » ».
  expect(cleanOpening('Cet article concerne le roman «\u00a0Le Chat.\u00a0» Le chat est un mammifère.')).toBe(
    'Le chat est un mammifère.',
  )
  expect(hasOpening('Pour les articles homonymes, voir X.')).toBe(false)
  expect(hasOpening(undefined)).toBe(false)
  expect(hasOpening('Le chat.')).toBe(true)
})

test('cutSummary : fin de phrase dans les max premiers caractères, sinon dernier blanc et …', () => {
  expect(cutSummary('Un. Deux.', 10)).toBe('Un. Deux.')
  expect(cutSummary('Un. Deux. Trois.', 10)).toBe('Un. Deux.')
  expect(cutSummary('Un! Deux? Trois… Quatre.', 17)).toBe('Un! Deux? Trois…')
  expect(cutSummary('Le chat est un mammifère carnivore', 20)).toBe('Le chat est un…')
  expect(cutSummary('Anticonstitutionnellement', 10)).toBe('Anticonst…')
  const long = 'Mot '.repeat(500) + 'fin.'
  for (const max of [1, 5, 600, 1200]) expect(cutSummary(long, max).length).toBeLessThanOrEqual(max)
  // Point à l'indice max : hors des max premiers caractères.
  expect(cutSummary('Abcd. Efgh. Ijk', 10)).toBe('Abcd.')
  // Fin de phrase suivie d'un « » » (après une insécable ou non) ou d'une « ) » : pas de coupe dans la citation.
  const quote = 'Il dit «\u00a0Bonjour.\u00a0» puis part. Et la suite.'
  expect(cutSummary(quote, 25)).toBe('Il dit «\u00a0Bonjour.\u00a0»')
  expect(cutSummary('Il dit «Bonjour.» puis part. Et la suite.', 22)).toBe('Il dit «Bonjour.»')
  expect(cutSummary(quote, 17)).not.toContain('Bonjour.')
  expect(cutSummary('Né à Paris (en 1900.) Puis Lyon. Etc.', 25)).toBe('Né à Paris (en 1900.)')
  // « ! » ou « ? » suivi de « » » puis d'une ponctuation : pas une fin de phrase ; citation de plusieurs phrases jamais coupée.
  const cry = "Il s'écria « Au secours ! », puis partit. Et la suite."
  expect(cutSummary(cry, 45)).toBe("Il s'écria « Au secours ! », puis partit.")
  expect(cutSummary(cry, 30)).toBe("Il s'écria « Au secours ! »,…")
  const two = 'Il dit « Bonjour. Au revoir. » puis part. Et la suite.'
  expect(cutSummary(two, 45)).toBe('Il dit « Bonjour. Au revoir. » puis part.')
  expect(cutSummary(two, 25)).toBe('Il dit « Bonjour. Au…')
  // Repli : coupe au dernier blanc ordinaire, jamais sur l'insécable qui suit « .
  expect(cutSummary(quote, 17)).toBe('Il dit…')
})

test('cleanOpening : bandeaux relevés dans les tranches réelles de Cirrus', () => {
  // Phrases recopiées de raw/cirrus.ndjson (insécables comprises) ; les deux dernières n'ont pas de fin de phrase.
  const banners = [
    'Cet article est une ébauche concernant l’athlétisme, le sport universitaire et Rome.',
    'Vous pouvez partager vos connaissances en l’améliorant (comment ?) selon les recommandations des projets correspondants.',
    'Vous pouvez partager vos connaissances en l’améliorant (comment ?).',
    'Cet article ne cite pas suffisamment ses sources (octobre 2022).',
    "Si vous disposez d'ouvrages ou d'articles de référence ou si vous connaissez des sites web de qualité traitant du thème abordé ici, merci de compléter l'article en donnant les références utiles à sa vérifiabilité et en les liant à la section « Notes et références ».",
    'En pratique : Quelles sources sont attendues ? Comment ajouter mes sources ?',
    'Vous lisez un « article de qualité » labellisé en 2009.',
    'Article principal : Tournoi de tennis US Clay Court.',
    "Pour l'instrument d'orchestre, voir Hautbois.",
    'Pour plus d’informations, voyez le projet associé.',
    "Cet article traite de l'épreuve masculine.",
    'Cet article est orphelin. Moins de trois articles lui sont liés (avril 2020). Vous pouvez aider en ajoutant des liens vers [[Meyor]] dans les articles relatifs au sujet.',
    "Cette page est une très courte ébauche oubliée. À l'instar du célèbre « Une pomme est un fruit » qui a marqué l'histoire de Wikipédia, n'hésitez pas à la développer (comment ?) Vous pouvez également enrichir les pages proposées dans la rubrique « Pommes à croquer » du bistro du jour.",
    'Cette page d’homonymie répertorie des personnes partageant un même patronyme germanique.',
    "Cet article ne s'appuie pas, ou pas assez, sur des sources secondaires ou tertiaires (octobre 2019). L'article peut contenir des analyses et interprétations inexactes ou inédites de sources primaires. Pour améliorer la vérifiabilité de l'article ainsi que son intérêt encyclopédique, il est nécessaire, quand des sources primaires sont citées, de les associer à des analyses faites par des sources secondaires.",
    'Cette page contient des caractères spéciaux ou non latins. S’ils s’affichent mal (▯, ?, etc.), consultez la page d’aide Unicode.',
    'Cet article peut contenir un travail inédit ou des déclarations non vérifiées (septembre 2022). Vous pouvez aider en ajoutant des références ou en supprimant le contenu inédit. Voir la page de discussion pour plus de détails.',
    'Consultez la liste des tâches à accomplir en page de discussion.',
    "Trouver des sources sur « Trilogie d'Albert Simonin » : Archive Wikiwix Bing Cairn DuckDuckGo E. Universalis Gallica Google G. Books G. News G. Scholar Persée Qwant (zh) Baidu (ru) Yandex (wd) trouver des œuvres sur Wikidata",
    'Sur les autres projets Wikimedia : AKA, sur le Wiktionnaire Aka, sur le Wiktionnaire aka, sur Wikimedia Commons',
  ]
  expect(cleanOpening(`${banners.join(' ')} Le chat est un mammifère.`)).toBe('Le chat est un mammifère.')
  for (const b of banners) expect(cleanOpening(`${b} Le chat, sur le toit, dort.`)).toBe('Le chat, sur le toit, dort.')
  // Une phrase ordinaire qui commence comme un bandeau reste.
  expect(cleanOpening("À l'instar des autres romans, le récit est long.")).toBe("À l'instar des autres romans, le récit est long.")
  expect(cleanOpening('Cet article présente la liste des maires.')).toBe('Cet article présente la liste des maires.')
})

test('cleanOpening : bandeau dont le titre cité finit par « ! » ou « ? »', () => {
  expect(cleanOpening('Cet article concerne la chanson « Ça ira ! », pas le film. Le texte est connu.')).toBe('Le texte est connu.')
  expect(cleanOpening('Cet article concerne la collection « Que sais-je ? ». Le livre est court.')).toBe('Le livre est court.')
})

test('selectCommand : catalog.tsv et counts.json cohérents ; mode full retient tout', async () => {
  const dir = await catalogDir()
  const counts = await selectCommand({ dir, mode: 'sample', rate: 0.5 })
  const written: Counts = JSON.parse(await readFile(join(dir, 'counts.json'), 'utf8'))
  expect(written).toEqual(counts)
  expect(counts.mode).toBe('sample')
  expect(counts.rate).toBe(0.5)

  const lines = await Array.fromAsync(readTsv(join(dir, 'catalog.tsv')))
  expect(lines.map((l) => l.slice(0, 8))).toEqual([
    ['1', 'Chat', '1000', '250', 'R', 'Chat.jpg', 'Q146', '1'],
    ['3', 'Chien', '500', '0', 'C', null, null, '0.6'],
    ['4', 'Oiseau', '300', '0', 'C', null, null, '0'],
  ])
  const full: Record<string, number> = {}
  const selected: Record<string, number> = {}
  for (const l of lines) {
    const rarity = String(l[4])
    full[rarity] = (full[rarity] ?? 0) + 1
    expect(['0', '1']).toContain(l[8])
    if (l[8] === '1') selected[rarity] = (selected[rarity] ?? 0) + 1
  }
  expect(counts.full).toEqual({ L: 0, UR: 0, SR: 0, R: 0, PC: 0, C: 0, ...full })
  expect(counts.selected).toEqual({ L: 0, UR: 0, SR: 0, R: 0, PC: 0, C: 0, ...selected })
  expect(counts.selected).toEqual({ L: 0, UR: 0, SR: 0, R: 1, PC: 0, C: 1 })

  const all = await selectCommand({ dir, mode: 'full', rate: 0.09 })
  expect(all.selected).toEqual(all.full)
  const again = await Array.fromAsync(readTsv(join(dir, 'catalog.tsv')))
  expect(again.map((l) => l[8])).toEqual(['1', '1', '1'])
})
