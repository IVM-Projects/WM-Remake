import { randomUUID } from 'node:crypto'
import { latestOtp } from '../contract/mail.ts'
import { expect, test } from './fixtures'

// Critère de fin du M1 (D§13) : tout passe par l'interface et le banc (GoTrue, Mailpit, vérification automatique), sans psql.
test('parcours M1 : inscription → code → paquet → collection → étiquette → défausse', async ({ page }) => {
  const id = randomUUID().slice(-12)
  const email = `e2e_${id}@test.local`

  await page.goto('/signup')
  const form = page.locator('form#signup-form')
  await form.locator('#username').fill(`e2e_${id}`)
  await form.locator('#email').fill(email)
  await form.locator('#password').fill('mot-de-passe-e2e')
  await form.getByLabel(/^Je confirme avoir au moins 18 ans/).check()
  await form.getByLabel(/^J'accepte les Conditions d'utilisation/).check()
  await form.getByRole('button', { name: 'Créer mon compte' }).click()
  await page.locator('#signup-otp-code').fill(await latestOtp(email))
  await page.getByRole('button', { name: 'Valider le code' }).click()
  await expect(page).toHaveURL('/pulls')

  // Compte neuf : le premier « Ouvrir » passe par la vérification anti-bot, que le banc (sans clé de site) valide seul.
  await page.getByRole('button', { name: 'Ouvrir', exact: true }).click()
  for (let n = 1; n < 5; n++) {
    await expect(page.getByText(`Carte ${n} / 5`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Carte suivante' }).click()
  }
  await expect(page.getByText('Carte 5 / 5', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page.getByRole('region', { name: 'Récapitulatif' }).locator('div[class*="glow-"]')).toHaveCount(5)

  // Doublons possibles dans un paquet, mais une ligne user_cards par copie (wm.grant_copy) : toujours 5 tuiles.
  await page.goto('/collection')
  const tiles = page.locator('div.flex.flex-wrap.justify-center.gap-3 > div.relative.isolate.group')
  await expect(tiles).toHaveCount(5)
  const balance = page.locator('main h1 + p')
  await expect(balance).toHaveText('0 wikibidous')

  await tiles.first().locator('h3 button').click()
  const dialog = page.getByRole('dialog')
  const field = dialog.getByPlaceholder('Ajouter une étiquette…')
  await field.fill('départ')
  await field.press('Enter')
  await expect(dialog.getByText('#départ', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Fermer' }).click()
  await expect(dialog).toBeHidden()

  const tagFilter = page.getByRole('combobox', { name: 'Filtrer par étiquette' })
  await tagFilter.selectOption({ label: 'départ (1)' })
  await expect(tiles).toHaveCount(1)

  await tiles.first().locator('h3 button').click()
  await dialog.getByRole('button', { name: /^Défausser/ }).click()
  await expect(dialog).toBeHidden()
  await expect(balance).toHaveText('1 wikibidous')
  await expect(tiles).toHaveCount(0)
  await tagFilter.selectOption({ label: 'Toutes les étiquettes' })
  await expect(tiles).toHaveCount(4)
})
