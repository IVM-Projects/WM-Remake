import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { pageTitle } from '../lib/brand.ts'
import { formatInt } from '../lib/format.ts'
import { expect, sql, test } from './fixtures'

test('/credits sans session : sources, licences, seuils de rareté et mention d\'indépendance', async ({ page }) => {
  await page.goto('/credits')
  await expect(page).toHaveTitle(pageTitle('Crédits'))
  await expect(page.locator('main h1')).toHaveText('Crédits et licences')
  await expect(page.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/deed.fr')
  await expect(page.getByRole('link', { name: 'CC0' })).toHaveAttribute('href', 'https://creativecommons.org/publicdomain/zero/1.0/deed.fr')
  // formatInt : espace fine insécable (U+202F) entre les milliers.
  await expect(page.getByText(`L : ${formatInt(20000)} vues ou plus`, { exact: true })).toBeVisible()
  await expect(page.getByText('C : moins de 50', { exact: true })).toBeVisible()
  await expect(page.getByText('Projet indépendant de la Fondation Wikimedia.', { exact: true })).toBeVisible()
})

test('pied de page du jeu : mention et lien vers /credits, hors de la nav', async ({ page, login }) => {
  await login()
  await page.goto('/pulls')
  const footer = page.locator('main footer')
  await expect(footer).toContainText('Projet indépendant de la Fondation Wikimedia')
  await expect(footer.getByRole('link', { name: 'Crédits', exact: true })).toHaveAttribute('href', '/credits')
  await expect(page.locator('nav a[href="/credits"]')).toHaveCount(0)
  for (const [name, href] of [['Conditions', '/terms'], ['Règles', '/rules'], ['Confidentialité', '/privacy']]) {
    await expect(footer.getByRole('link', { name, exact: true })).toHaveAttribute('href', href)
  }
})

// Ouvre la seule copie du joueur, préférences lues avant l'ouverture ; « Vues (30j) » prouve que les lectures de l'ouverture
// (méta et crédits) sont parties et revenues.
async function openCopy(page: Page, title: string) {
  const prefs = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings/preferences')
  await page.goto('/collection')
  await prefs
  await page.getByRole('button', { name: title, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Vues (30j) : 0', { exact: true })).toBeVisible()
  return dialog
}

test('modale : auteur et licence de l\'image affichée, rien quand l\'image est masquée, sensible ou absente', async ({ page, login }) => {
  const { uid } = await login()
  // Fin non numérique : le helper collection() d'a11y.spec.ts prend les titres finissant par 0001, 0007…
  const title = `Zz crédits e2e ${randomUUID().slice(-12)} z`
  // Wikimedia est injoignable du banc : l'image est l'icône du site.
  const id = sql(`insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, image_url)
values (:'title', 'https://fr.wikipedia.org/wiki/Zz', 'C', 1000, 1000, 'http://127.0.0.1:3100/icon') returning id`, { title })
  const asked: string[] = []
  // /api/cards/ seulement : le lien « Crédits » du pied de page précharge /credits.
  page.on('request', (r) => { if (/^\/api\/cards\/.+\/credits$/.test(new URL(r.url()).pathname)) asked.push(new URL(r.url()).pathname) })
  try {
    sql(`insert into wm.card_media (card_id, file, author, license, license_url)
values (:'id', 'Zz.jpg', 'Jean Dupont', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0');
insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
values (:'uid', :'id', :'title', 'C', 1000, 1000)`, { id, uid, title })

    let dialog = await openCopy(page, title)
    await expect(dialog.getByText('Image : Jean Dupont, CC BY-SA 4.0', { exact: true })).toBeVisible()
    const license = dialog.getByRole('link', { name: 'CC BY-SA 4.0', exact: true })
    await expect(license).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0')
    await expect(license).toHaveAttribute('target', '_blank')
    const author = dialog.getByRole('link', { name: 'Jean Dupont', exact: true })
    await expect(author).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Zz.jpg')
    await expect(author).toHaveAttribute('target', '_blank')
    expect(asked).toEqual([`/api/cards/${id}/credits`])

    // Image masquée par le staff : ni lecture des crédits, ni ligne.
    sql(`update public.cards set hide_image = true where id = :'id'`, { id })
    asked.length = 0
    dialog = await openCopy(page, title)
    await expect(dialog.getByText(/^Image :/)).toHaveCount(0)
    expect(asked).toEqual([])

    // Image sensible, préférence du joueur « masquer » (wm.user_prefs) : ni lecture, ni ligne ; préférence levée : la ligne revient.
    sql(`update public.cards set hide_image = false, nsfw_image = true where id = :'id';
insert into wm.user_prefs (user_id, hide_sensitive) values (:'uid', true) on conflict (user_id) do update set hide_sensitive = true`, { id, uid })
    dialog = await openCopy(page, title)
    await expect(dialog.getByText(/^Image :/)).toHaveCount(0)
    expect(asked).toEqual([])
    sql(`update wm.user_prefs set hide_sensitive = false where user_id = :'uid'`, { uid })
    dialog = await openCopy(page, title)
    await expect(dialog.getByText('Image : Jean Dupont, CC BY-SA 4.0', { exact: true })).toBeVisible()
    expect(asked).toEqual([`/api/cards/${id}/credits`])
    asked.length = 0

    // Carte sans image (son média reste) : pas de ligne non plus.
    sql(`update public.cards set nsfw_image = false, image_url = null where id = :'id'`, { id })
    dialog = await openCopy(page, title)
    await expect(dialog.getByText(/^Image :/)).toHaveCount(0)
    expect(asked).toEqual([])
  } finally {
    sql(`delete from public.user_cards where card_id = :'id';
delete from wm.card_media where card_id = :'id';
delete from public.cards where id = :'id'`, { id })
  }
})

// Deux cartes et non une mise à jour du média : /api/cards/{id}/credits est en cache dans le navigateur (max-age).
test('modale à 320 px : sans auteur, « voir la page du fichier » ; un auteur sans espace ne déborde pas', async ({ page, login }) => {
  const { uid } = await login()
  await page.setViewportSize({ width: 320, height: 640 })
  const suffix = randomUUID().slice(-12)
  const copies = [
    { title: `Zz crédits anonyme ${suffix} z`, file: "Château_de_l'Été_(1889).jpg", author: '' },
    { title: `Zz crédits long ${suffix} z`, file: 'Zz.jpg', author: 'Anthony_Réveillère_Euro_2012_vs_Spain.jpg: Станислав Ведмидь derivative work: Simo82' },
  ]
  const ids: string[] = []
  try {
    for (const c of copies) {
      const id = sql(`insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, image_url)
values (:'title', 'https://fr.wikipedia.org/wiki/Zz', 'C', 1000, 1000, 'http://127.0.0.1:3100/icon') returning id`, c)
      ids.push(id)
      sql(`insert into wm.card_media (card_id, file, author, license, license_url)
values (:'id', :'file', nullif(:'author', ''), 'CC BY-SA 3.0', null);
insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
values (:'uid', :'id', :'title', 'C', 1000, 1000)`, { ...c, id, uid })
    }

    let dialog = await openCopy(page, copies[0].title)
    await expect(dialog.getByText('Image : voir la page du fichier, CC BY-SA 3.0', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('link', { name: 'voir la page du fichier', exact: true }))
      .toHaveAttribute('href', "https://commons.wikimedia.org/wiki/File:Ch%C3%A2teau_de_l'%C3%89t%C3%A9_(1889).jpg")

    // WCAG 1.4.10 : le crédit tient dans sa colonne (sans coupure, son premier mot la dépasse de 17 px à 320 px).
    dialog = await openCopy(page, copies[1].title)
    const credit = dialog.getByText(/^Image : Anthony_Réveillère/)
    await expect(credit).toBeVisible()
    expect(await credit.evaluate((p) => p.scrollWidth - p.clientWidth)).toBe(0)
  } finally {
    for (const id of ids) sql(`delete from public.user_cards where card_id = :'id';
delete from wm.card_media where card_id = :'id';
delete from public.cards where id = :'id'`, { id })
  }
})
