import type { BrowserContext, Locator, Page } from '@playwright/test'
import { brand } from '../lib/brand.ts'
import { cookieFor, expect, giveCopies, imageCopy, makePlayer, makeStaff, sql, test } from './fixtures'

const MIN_TARGET = 44 - 0.01
const REASON = 'Motif de la recette'
const ready = (page: Page) => page.locator('main [data-ready]').filter({ visible: true }).waitFor()
const dialog = (page: Page) => page.getByRole('dialog')
const toastOf = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text })

// Cible de 44 px (A11y) sur ce qu'on active, puis clavier seul : focus et Entrée.
async function press(target: Locator) {
  const box = (await target.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET)
  expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET)
  await target.focus()
  await target.press('Enter')
}
const openButton = (page: Page) => page.getByRole('button', { name: 'Ouvrir', exact: true })

// Recette M6a (jalon) : un joueur signale l'image d'une carte, le staff la masque ; le staff bannit le joueur, dont le JWT reste valide
// (écritures et lectures refusées), puis lève la sanction ; le journal garde exactement les trois actions. Un contexte de navigateur par
// personne ; seules écritures SQL : l'étape 1 (staff, joueur, carte dédiée, copies) ; le reste passe par les pages.
test('parcours M6a : image signalée puis masquée, bannissement effectif malgré un JWT valide, levée, journal', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const contexts: BrowserContext[] = []
  const uids: string[] = []
  let card = ''
  try {
    // 1. S (admin), P (joueur), la carte dédiée X (copie de P, image rendue unique) et trois copies C pour P.
    const s = makeStaff('admin')
    uids.push(s.uid)
    const p = makePlayer()
    uids.push(p.uid)
    const copy = imageCopy(p)
    card = sql(`select card_id from public.user_cards where id = :'copy'`, { copy })
    sql(`update public.cards set image_url = image_url || '#' || id where id = :'card'`, { card })
    const title = sql(`select wikipedia_title from public.cards where id = :'card'`, { card })
    giveCopies(p, 'C', 3)
    for (const u of [s, p]) {
      const ctx = await browser.newContext()
      contexts.push(ctx)
      await ctx.addCookies([{ ...cookieFor(u), url: baseURL! }])
    }
    const [sp, pp] = await Promise.all(contexts.map((c) => c.newPage()))

    // 2. P signale l'image de X depuis la modale de sa collection.
    await pp.goto('/collection')
    await pp.getByRole('button', { name: title, exact: true }).click()
    const report = pp.getByRole('dialog', { name: title }).getByRole('button', { name: 'Signaler l\'image' })
    await expect(report).toHaveAttribute('aria-pressed', 'false')
    await press(report)
    await expect(report).toHaveAttribute('aria-pressed', 'true')

    // 3. S : X à un signalement dans « Images » ; « Masquer l'image » avec un motif vide la file.
    await sp.goto('/admin/reports')
    await ready(sp)
    await sp.getByRole('tab', { name: 'Images' }).click()
    const line = sp.getByRole('listitem').filter({ hasText: title })
    await expect(line).toContainText('1 signalement')
    await line.getByRole('button', { name: 'Masquer l\'image' }).click()
    await dialog(sp).getByLabel('Motif (obligatoire)').fill(REASON)
    await dialog(sp).getByRole('button', { name: 'Masquer l\'image' }).click()
    await expect(line).toHaveCount(0)

    // 4. P relit sa collection (la grille ne se relit qu'à l'affichage) : l'emblème remplace l'image, plus de bouton « Signaler l'image ».
    await pp.goto('/collection')
    await pp.getByRole('button', { name: title, exact: true }).click()
    const modal = pp.getByRole('dialog', { name: title })
    await expect(modal.getByRole('img', { name: brand.name })).toBeVisible()
    await expect(modal.getByRole('button', { name: 'Signaler l\'image' })).toHaveCount(0)

    // 5. S bannit P depuis sa fiche : toast, puis GoTrue le dit banni.
    await sp.goto('/admin/users')
    const search = sp.getByRole('searchbox', { name: 'Rechercher un joueur' })
    await search.fill(p.username)
    await search.press('Enter')
    await sp.getByRole('link', { name: new RegExp(p.username) }).click()
    await expect(sp.getByRole('heading', { name: p.username })).toBeVisible()
    await sp.getByRole('button', { name: 'Sanctionner', exact: true }).click()
    await dialog(sp).getByRole('radio', { name: 'Bannissement' }).check()
    await dialog(sp).getByLabel('Motif (obligatoire)').fill(REASON)
    await dialog(sp).getByRole('button', { name: 'Sanctionner', exact: true }).click()
    await expect(toastOf(sp, 'Sanction enregistrée.')).toBeVisible()
    expect(sql(`select banned_until is not null from auth.users where id = :'u'`, { u: p.uid })).toBe('t')

    // 6. JWT encore valide, cookie inchangé : l'écriture et la lecture sont refusées.
    await pp.goto('/pulls')
    await openButton(pp).click()
    await expect(pp.getByRole('alert').filter({ hasText: 'Ton compte est temporairement restreint.' })).toBeVisible()
    await pp.goto('/collection')
    await expect(pp.getByText('Ta collection n\'a pas pu être chargée.')).toBeVisible()

    // 7. S lève la sanction avec un motif ; P ouvre de nouveau un paquet.
    const table = sp.getByRole('table', { name: `Sanctions de ${p.username}` })
    await table.getByRole('button', { name: 'Lever' }).click()
    await dialog(sp).getByLabel('Motif (obligatoire)').fill(REASON)
    await dialog(sp).getByRole('button', { name: 'Lever' }).click()
    await expect(table.getByRole('button', { name: 'Lever' })).toHaveCount(0)
    await pp.goto('/pulls')
    await openButton(pp).click()
    await expect(pp.getByText('Carte 1 / 5', { exact: true })).toBeVisible()

    // 8. Le journal de S : trois lignes, la plus récente d'abord. Le signalement du joueur n'en écrit aucune.
    await sp.goto('/admin/audit')
    await ready(sp)
    const mine = sp.getByRole('table').getByRole('row').filter({ hasText: s.username })
    await expect(mine).toHaveCount(3)
    await expect(mine.nth(0)).toContainText('Sanction levée')
    await expect(mine.nth(1)).toContainText('Sanction')
    await expect(mine.nth(1)).not.toContainText('Sanction levée')
    await expect(mine.nth(2)).toContainText('Drapeaux d\'image')
    expect(sql(`select count(*) from wm.staff_actions where staff_id = :'s'`, { s: s.uid })).toBe('3')

    // 9. Invariants vides pour P.
    expect(sql(`select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(wm.check_invariants()) v where v ->> 'user_id' = :'p'`, { p: p.uid })).toBe('[]')
  } finally {
    await Promise.allSettled(contexts.map((c) => c.close()))
    const ids = uids.join(',')
    sql(`delete from wm.staff_actions where staff_id = any(string_to_array(:'u', ',')::uuid[]) or target_id = any(string_to_array(:'u', ',') || :'c'::text)`, { u: ids, c: card })
    if (card) {
      sql(`delete from public.user_cards where card_id = :'c'`, { c: card })
      sql(`delete from public.cards where id = :'c'`, { c: card })
    }
    sql(`delete from auth.users where id = any(string_to_array(:'u', ',')::uuid[])`, { u: ids })
  }
})
