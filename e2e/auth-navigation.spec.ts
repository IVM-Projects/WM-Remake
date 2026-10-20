import type { Page } from '@playwright/test'
import { latestOtp } from '../contract/mail.ts'
import { expect, fresh, logIn, makePlayer, sql, test } from './fixtures'

// Joueur confirmé avec un mot de passe (bcrypt de pgcrypto, lu par GoTrue) : connexion sans passer par Mailpit.
function withPassword(): { email: string; password: string } {
  const { uid } = makePlayer()
  const password = 'mot-de-passe-e2e'
  sql(`update auth.users set encrypted_password = extensions.crypt(:'password', extensions.gen_salt('bf')) where id = :'uid'`, { uid, password })
  return { email: `${uid}@test.local`, password }
}

// Accueil sans session : le logo (<Link href="/pulls">) est préchargé (build de production) et le proxy répond
// /login?next=%2Fpulls. On attend que ce préchargement redirigé soit fini avant d'agir.
async function homeAfterLogoPrefetch(page: Page) {
  const prefetched = page.waitForResponse((r) => {
    const from = r.request().redirectedFrom()
    return new URL(r.url()).pathname === '/login' && !!from && new URL(from.url()).pathname === '/pulls'
  })
  await page.goto('/')
  await (await prefetched).finished()
}

const pullsVisible = (page: Page) => expect(page.locator('main h1').filter({ visible: true })).toHaveText('Paquets')

test('accueil (logo préchargé) → « Créer un compte » → code → /pulls', async ({ page }) => {
  const a = fresh()
  await homeAfterLogoPrefetch(page)
  await page.getByRole('link', { name: 'Créer un compte' }).click()
  await expect(page).toHaveURL('/signup')
  const form = page.locator('form#signup-form')
  await form.locator('#username').fill(a.username)
  await form.locator('#email').fill(a.email)
  await form.locator('#password').fill(a.password)
  await form.getByLabel(/^Je confirme avoir au moins 18 ans/).check()
  await form.getByLabel(/^J'accepte les Conditions d'utilisation/).check()
  await form.getByRole('button', { name: 'Créer mon compte' }).click()
  await page.locator('#signup-otp-code').fill(await latestOtp(a.email))
  await page.getByRole('button', { name: 'Valider le code' }).click()
  await expect(page).toHaveURL('/pulls')
  await pullsVisible(page)
})

test('accueil (logo préchargé) → « Se connecter » → /pulls', async ({ page }) => {
  const { email, password } = withPassword()
  await homeAfterLogoPrefetch(page)
  await page.getByRole('link', { name: 'Se connecter' }).click()
  await expect(page).toHaveURL('/login')
  await logIn(page, email, password)
  await expect(page).toHaveURL('/pulls')
  await pullsVisible(page)
})

// Next 16 ne polyfille que URL.canParse ; URL.parse manque sous Safari < 18 et Chrome/Firefox < 126.
test('navigateur sans URL.parse : connexion avec ?next= → next', async ({ page }) => {
  const { email, password } = withPassword()
  await page.addInitScript(() => Reflect.deleteProperty(URL, 'parse'))
  await page.goto('/login?next=%2Fcollection')
  await logIn(page, email, password)
  await expect(page).toHaveURL('/collection')
})

test('mauvais mot de passe → le focus reste sur « Se connecter »', async ({ page }) => {
  await page.goto('/login')
  await logIn(page, 'personne@test.local', 'mauvais-mot-de-passe')
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Adresse courriel ou mot de passe incorrect.')
  await expect(page.getByRole('button', { name: 'Se connecter' })).toBeFocused()
})

test.describe('avant l\'hydratation (JavaScript coupé)', () => {
  test.use({ javaScriptEnabled: false })
  test('boutons d\'envoi des formulaires d\'authentification nativement désactivés', async ({ page }) => {
    for (const [path, name] of [['/login', 'Se connecter'], ['/signup', 'Créer mon compte'], ['/forgot-password', 'Envoyer le lien']]) {
      await page.goto(path)
      await expect(page.getByRole('button', { name })).toHaveAttribute('disabled', '')
    }
  })
})
