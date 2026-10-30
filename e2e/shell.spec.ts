import { expect, test } from './fixtures'

// [href, libellé, icône lucide, h1] dans l'ordre de R§2.2.
const NAV = [
  ['/pulls', 'Paquets', 'puzzle', 'Paquets'],
  ['/collection', 'Collection', 'book-open', 'Collection'],
  ['/trades', 'Échanges', 'handshake', 'Échanges'],
  ['/marketplace', 'Marché', 'gavel', 'Marché'],
  ['/profile', 'Profil', 'user', 'Profil'],
  ['/global-collection', 'Toutes les cartes', 'globe', 'Collection Globale'],
  ['/guild', 'Guilde', 'castle', 'Guilde'],
  ['/friends', 'Amis', 'users', 'Amis'],
  ['/dms', 'Messages', 'message-circle', 'Messages'],
  ['/battle', 'Bataille', 'swords', 'Bataille'],
  ['/achievements', 'Succès', 'trophy', 'Succès'],
  ['/leaderboard', 'Classement', 'medal', 'Classement'],
  ['/settings', 'Paramètres', 'settings', 'Paramètres'],
] as const

test('barre latérale : 13 entrées dans l\'ordre', async ({ page, login }) => {
  await login(); await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/pulls')
  const links = page.locator('nav.hidden a[href^="/"]').filter({ hasNotText: /^$/ })
  await expect(links).toHaveText(['Paquets','Collection','Échanges','Marché','Profil','Toutes les cartes','Guilde','Amis','Messages','Bataille','Succès','Classement','Paramètres'])
  await expect(page.locator('nav.hidden a[aria-current="page"]')).toHaveText('Paquets')
  await expect(page.locator('button[aria-label="Notifications"]').first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr')

  expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(NAV.map(([href]) => href))
  expect(await links.evaluateAll((as) => as.map((a) => a.querySelector('svg')?.classList[1]))).toEqual(NAV.map(([, , icon]) => `lucide-${icon}`))
  await expect(page.locator('nav.hidden a[aria-current="page"]')).toHaveClass(/bg-\[var\(--color-accent\)\]\/10 text-\[var\(--color-accent\)\]/)
  // Contrat DOM R§6.3 : c'est main qui défile, pas body.
  await expect(page.locator('body > div.flex.h-dvh nav.hidden.w-64.md\\:flex')).toBeVisible()
  await expect(page.locator('body > div.flex.h-dvh main.min-h-0.flex-1.overflow-y-auto')).toBeVisible()
  await expect(page.locator('button.relative.p-2.rounded-xl[aria-label="Notifications"]')).toBeVisible()
  await expect(page.locator('a[href="/pulls"] > h1')).toHaveText(/\S/)
})

test('mobile : 4 entrées + Plus', async ({ page, login }) => {
  await login(); await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/pulls')
  const bar = page.locator('nav.order-last')
  await expect(bar).toHaveClass(/pb-\[calc\(6px\+env\(safe-area-inset-bottom,0px\)\)\]/)
  await expect(page.locator('nav.hidden')).toBeHidden()
  for (const label of ['Paquets', 'Collection', 'Échanges', 'Marché']) await expect(bar.getByRole('link', { name: label })).toBeVisible()
  await expect(bar.getByRole('link')).toHaveCount(4)
  // Cibles tactiles d'au moins 44 px (D§8.6).
  const sides = await page.locator('header a, header button, nav.order-last a, nav.order-last button')
    .evaluateAll((els) => els.map((e) => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height)))
  expect(Math.min(...sides)).toBeGreaterThanOrEqual(44)

  const more = bar.getByRole('button', { name: 'Plus' })
  await more.click()
  const sheet = page.getByRole('dialog', { name: 'Plus' })
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAttribute('aria-modal', 'true')
  await expect(sheet.getByRole('link')).toHaveText(['Profil','Toutes les cartes','Guilde','Amis','Messages','Bataille','Succès','Classement','Paramètres'])
  // Piège de focus : Tab ne sort jamais de la feuille.
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(key)
      expect(await sheet.evaluate((d) => d.contains(document.activeElement)), `${key} n° ${i + 1}`).toBe(true)
    }
  }
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(more).toBeFocused()

  // Ouverte et fermée à la souris : le focus revient à « Plus » sans compter sur le navigateur.
  // dispatchEvent ne focalise pas le bouton, comme un clic sous Safari : le focus natif irait sur body.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await more.dispatchEvent('click')
  await sheet.getByRole('button', { name: 'Fermer le menu' }).click()
  await expect(sheet).toBeHidden()
  await expect(more).toBeFocused()
  await expect(page.locator('[aria-label="Fermer"]')).toHaveCount(0)

  // Un lien de la feuille navigue et la referme.
  await more.click()
  await sheet.getByRole('link', { name: 'Amis' }).click()
  await expect(page).toHaveURL('/friends')
  // Cache Components garde jusqu'à 3 pages quittées dans le DOM (display: none) : seul le h1 visible compte.
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText('Amis')
  await expect(sheet).toBeHidden()
})

test.describe('chaque page a son h1', () => {
  for (const [href, , , title] of NAV) {
    test(href, async ({ page, login }) => {
      await login()
      await page.goto(href)
      await expect(page.locator('main h1')).toHaveText(title)
      await expect(page).toHaveTitle(new RegExp(`^${title} — `))
      if (!['/pulls', '/collection', '/marketplace', '/profile', '/global-collection', '/friends', '/dms', '/trades', '/settings', '/battle', '/guild'].includes(href)) await expect(page.locator('main')).toContainText('Cette section arrive bientôt.')
    })
  }
})

test('accueil et connexion, sans session', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1')).toHaveText(/\S/)
  await expect(page.getByRole('link', { name: 'Se connecter' })).toHaveAttribute('href', '/login')
  await expect(page.getByRole('link', { name: 'Créer un compte' })).toHaveAttribute('href', '/signup')
  await page.getByRole('link', { name: 'Se connecter' }).click()
  await expect(page).toHaveURL('/login')
  await expect(page).toHaveTitle(/^Connexion — /)
  await expect(page.locator('h1').filter({ visible: true })).toHaveText('Connexion')
  await page.goto('/')
  await page.getByRole('link', { name: 'Créer un compte' }).click()
  await expect(page).toHaveURL('/signup')
  await expect(page).toHaveTitle(/^Inscription — /)
  await expect(page.locator('h1').filter({ visible: true })).toHaveText('Inscription')
})
