import type { Page } from '@playwright/test'
import { latestLink, latestOtp } from '../contract/mail.ts'
import { pageTitle } from '../lib/brand.ts'
import { type Account, expect, fresh, logIn, makePlayer, test } from './fixtures'

// Textes exacts des deux cases (R§2.1).
const AGE = 'Je confirme avoir au moins 18 ans et je comprends que les cartes proviennent de Wikipédia et peuvent inclure du contenu sensible.'
const TERMS = 'J\'accepte les Conditions d\'utilisation et les Règles de la communauté.'

async function fillSignup(page: Page, a: Account) {
  await page.goto('/signup')
  const form = page.locator('form#signup-form')
  await form.locator('#username').fill(a.username)
  await form.locator('#email').fill(a.email)
  await form.locator('#password').fill(a.password)
  return form
}

// Jusqu'à l'étape du code : le compte existe mais n'est pas confirmé.
async function signUp(page: Page): Promise<Account> {
  const a = fresh()
  const form = await fillSignup(page, a)
  await form.getByLabel(AGE, { exact: true }).check()
  await form.getByLabel(TERMS, { exact: true }).check()
  await form.getByRole('button', { name: 'Créer mon compte' }).click()
  await expect(page.locator('#signup-otp-code')).toBeVisible()
  return a
}

async function enterCode(page: Page, code: string) {
  await page.locator('#signup-otp-code').fill(code)
  await page.getByRole('button', { name: 'Valider le code' }).click()
  await expect(page).toHaveURL('/pulls')
}

test('inscription → code par courriel → /pulls', async ({ page }) => {
  await page.goto('/signup')
  await expect(page).toHaveTitle(pageTitle('Inscription'))
  const form = page.locator('form#signup-form')
  await expect(form.locator('#username')).toHaveAttribute('autocomplete', 'username')
  await expect(form.locator('#email')).toBeVisible()
  await expect(form.locator('#password')).toHaveAttribute('autocomplete', 'new-password')
  await expect(form.getByLabel(AGE, { exact: true })).toHaveAttribute('type', 'checkbox')
  await expect(form.getByLabel(TERMS, { exact: true })).toHaveAttribute('type', 'checkbox')
  await expect(form.getByRole('link', { name: 'Conditions d\'utilisation' })).toHaveAttribute('href', '/terms')
  await expect(form.getByRole('link', { name: 'Règles de la communauté' })).toHaveAttribute('href', '/rules')

  const a = await signUp(page)
  const otp = page.locator('#signup-otp-code')
  await expect(otp).toHaveAttribute('name', 'otp')
  await expect(otp).toHaveAttribute('inputmode', 'numeric')
  await expect(otp).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(otp).toHaveAttribute('pattern', '\\d{6,12}')
  await enterCode(page, await latestOtp(a.email))
  // Cache Components garde la page quittée dans le DOM (display: none) : seul le h1 visible compte.
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText('Paquets')
})

test('pseudo déjà pris → message avant envoi', async ({ page }) => {
  const { username } = makePlayer()
  await page.goto('/signup')
  const form = page.locator('form#signup-form')
  const submit = form.getByRole('button', { name: 'Créer mon compte' })
  await expect(submit).toBeEnabled() // hydraté : le blur est écouté
  const field = form.locator('#username')
  await field.fill(username.toUpperCase())
  await field.blur()
  await expect(form.getByRole('alert')).toHaveText('Ce pseudo est déjà pris')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(submit).toBeDisabled()
  await field.fill('Admin')
  await field.blur()
  await expect(form.getByRole('alert')).toHaveText('Ce pseudo est réservé')
  await field.fill(fresh().username)
  // La réponse du pseudo libre ne change rien à l'écran : on l'attend avant de vérifier qu'il n'y a plus d'erreur.
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes('/api/username-available?')), field.blur()])
  expect(await res.json()).toEqual({ available: true })
  await expect(submit).toBeEnabled()
  await expect(form.getByRole('alert')).toHaveCount(0)
})

// Sans blur (Entrée dans le champ) : refus du trigger, que GoTrue masque en « Database error saving new user ».
test('pseudo pris envoyé quand même → « Ce pseudo est déjà pris », pas d\'étape du code', async ({ page }) => {
  const { username } = makePlayer()
  const form = await fillSignup(page, { ...fresh(), username: 'placeholder' })
  await form.getByLabel(AGE, { exact: true }).check()
  await form.getByLabel(TERMS, { exact: true }).check()
  await expect(form.getByRole('button', { name: 'Créer mon compte' })).toBeEnabled()
  await form.locator('#username').fill(username)
  await form.locator('#username').press('Enter')
  await expect(form.getByRole('alert')).toHaveText('Ce pseudo est déjà pris')
  await expect(form.locator('#username')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#signup-otp-code')).toHaveCount(0)
})

test('cases non cochées → envoi impossible', async ({ page }) => {
  const form = await fillSignup(page, fresh())
  const age = form.getByLabel(AGE, { exact: true })
  const terms = form.getByLabel(TERMS, { exact: true })
  await expect(age).toHaveAttribute('required', '')
  await expect(terms).toHaveAttribute('required', '')
  const valid = () => form.evaluate((f: HTMLFormElement) => f.checkValidity())
  expect(await valid()).toBe(false)
  await age.check()
  expect(await valid()).toBe(false)
  await age.uncheck()
  await terms.check()
  expect(await valid()).toBe(false)
  await age.check()
  expect(await valid()).toBe(true)
})

test('connexion → next restauré', async ({ page, context }) => {
  const a = await signUp(page)
  await enterCode(page, await latestOtp(a.email))
  await context.clearCookies()

  await page.goto('/collection')
  await expect(page).toHaveURL('/login?next=%2Fcollection')
  await expect(page).toHaveTitle(pageTitle('Connexion'))
  await expect(page.locator('#email')).toHaveAttribute('type', 'email')
  await logIn(page, a.email, 'mauvais-mot-de-passe')
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Adresse courriel ou mot de passe incorrect.')
  await logIn(page, a.email, a.password)
  await expect(page).toHaveURL('/collection')

  await context.clearCookies()
  await page.goto('/login')
  await logIn(page, a.email, a.password)
  await expect(page).toHaveURL('/pulls')
})

test('mot de passe oublié → lien → nouveau mot de passe → connexion', async ({ page, context }) => {
  const { uid } = makePlayer()
  const email = `${uid}@test.local` // adresse posée par tests.make_user
  await page.goto('/login')
  await page.getByRole('link', { name: 'Mot de passe oublié ?' }).click()
  await expect(page).toHaveURL('/forgot-password')
  await expect(page).toHaveTitle(pageTitle('Mot de passe oublié'))
  await expect(page.getByRole('main')).toContainText('Nous vous enverrons un lien pour choisir un nouveau mot de passe.')
  await page.getByLabel('Adresse courriel').fill(email)
  await page.getByRole('button', { name: 'Envoyer le lien' }).click()
  await expect(page.getByRole('main').getByRole('status')).toHaveText(/un lien vient d'être envoyé/)

  // Lien PKCE : /auth/v1/verify → /callback?next=/reset-password&code=… → /reset-password.
  await page.goto(await latestLink(email))
  await expect(page).toHaveURL('/reset-password')
  await expect(page).toHaveTitle(pageTitle('Nouveau mot de passe'))
  await page.getByLabel('Nouveau mot de passe').fill('nouveau-mot-de-passe')
  await page.getByRole('button', { name: 'Enregistrer le mot de passe' }).click()
  await expect(page).toHaveURL('/pulls')

  await context.clearCookies()
  await page.goto('/login')
  await logIn(page, email, 'nouveau-mot-de-passe')
  await expect(page).toHaveURL('/pulls')
})

test('lien de réinitialisation invalide → « Lien invalide ou expiré »', async ({ page }) => {
  await page.goto('/callback?code=faux&next=/reset-password')
  await expect(page).toHaveURL('/reset-password?error=invalid')
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Lien invalide ou expiré')
  // Sans session non plus : aucun formulaire.
  await page.goto('/reset-password')
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Lien invalide ou expiré')
  await expect(page.getByLabel('Nouveau mot de passe')).toHaveCount(0)
  // Autre lien refusé : retour à la connexion avec le même message.
  await page.goto('/callback?code=faux&next=/collection')
  await expect(page).toHaveURL('/login?error=invalid')
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Lien invalide ou expiré')
})

test('compte non confirmé → /verify-email (adresse hors de l\'URL), renvoi du code', async ({ page }) => {
  const a = await signUp(page)
  const first = await latestOtp(a.email)
  // Aucune PII dans les journaux de requêtes ni l'historique : l'adresse ne figure dans aucune URL demandée.
  const urls: string[] = []
  page.on('request', (r) => urls.push(decodeURIComponent(r.url())))
  // D'abord sans adresse : la page gardée en mémoire (Activity) puis réaffichée doit relire l'adresse posée par /login.
  await page.goto('/verify-email')
  await page.getByRole('main').getByRole('link', { name: 'Se connecter' }).click()
  await expect(page).toHaveURL('/login')
  await logIn(page, a.email, a.password)
  await expect(page).toHaveURL('/verify-email')
  await expect(page).toHaveTitle(pageTitle('Vérifier l\'e-mail'))
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('Vérifier l\'e-mail')
  await expect(page.locator('#signup-otp-code')).toBeVisible()

  // GOTRUE_SMTP_MAX_FREQUENCY = 1 s depuis le premier e-mail ; latestOtp lit le plus récent, on attend donc le second.
  await page.waitForTimeout(1_100)
  await page.getByRole('button', { name: 'Renvoyer le code' }).click()
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Nouveau code envoyé.')
  let code = first
  await expect.poll(async () => (code = await latestOtp(a.email))).not.toBe(first)
  await enterCode(page, code)
  expect(urls.filter((u) => u.includes(a.email))).toEqual([])
  expect(await page.evaluate(() => sessionStorage.getItem('wm.verifyEmail'))).toBeNull()
})

test('/verify-email sans adresse → liens vers connexion et inscription', async ({ page }) => {
  await page.goto('/verify-email')
  const main = page.getByRole('main')
  await expect(main.getByRole('link', { name: 'Se connecter' })).toHaveAttribute('href', '/login')
  await expect(main.getByRole('link', { name: 'Créer un compte' })).toHaveAttribute('href', '/signup')
  await expect(page.locator('#signup-otp-code')).toHaveCount(0)
})
