// Manuel, jamais en CI (le banc et la CI n'atteignent pas api.stripe.com, D:93). Clé de test lue dans l'environnement seulement.
// `node scripts/stripe-clock.mjs <commande>` : horloges de test Stripe et contrôle des prix (G6, G15, G43). N'imprime que des ids,
// des statuts et des dates : jamais la clé ni un e-mail. Les montants viennent de lib/shop.ts, importé tel quel (Node >= 22.22 lit le .ts).
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import Stripe from 'stripe'
import { SHOP } from '../lib/shop.ts'

// Même valeur que lib/stripe.ts (server-only, non importable ici) ; stripe-clock.test.ts compare les deux.
export const STRIPE_API_VERSION = '2026-10-28.endive'

const USAGE = `Usage : STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-clock.mjs <commande>
  prices                          compare les Prices (STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_WB_2500) à lib/shop.ts
  start --uid <uuid>              horloge + Customer + abonnement Pro de test
  advance --clock <id> --days <n> avance l'horloge de n jours et attend qu'elle soit prête
  fail --clock <id>               les prochains débits échouent (pm_card_chargeCustomerFail)
  cancel --clock <id>             résiliation en fin de période
  delete --clock <id>             supprime l'horloge (Customer et abonnement avec)
Utilise un compte de démo neuf (un compte avec des achats existants fausse le contrôle).`

export function assertTestKey(key) {
  if (!key) throw new Error('STRIPE_SECRET_KEY absente.')
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('Clé refusée : seule une clé de test (sk_test_ ou rk_test_) est acceptée.')
  return key
}

// Écarts (messages sans identifiant) entre les deux Prices Stripe et SHOP.
export function checkPrices(pro, wb) {
  const bad = []
  const check = (name, price, interval) => {
    const want = SHOP[name]
    if (price.unit_amount !== want.cents) bad.push(`${name} : montant ${price.unit_amount} au lieu de ${want.cents}`)
    if (price.currency !== want.currency.toLowerCase()) bad.push(`${name} : devise ${price.currency} au lieu de ${want.currency.toLowerCase()}`)
    if ((price.recurring?.interval ?? null) !== interval) bad.push(`${name} : récurrence ${price.recurring?.interval ?? 'aucune'} au lieu de ${interval ?? 'aucune'}`)
  }
  check('pro_monthly', pro, SHOP.pro_monthly.interval)
  check('wb_2500', wb, null)
  return bad
}

// Interroge toutes les 2 s, 5 min au plus.
export async function waitReady(stripe, id, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = 300_000 } = {}) {
  const start = now()
  for (;;) {
    const { status } = await stripe.testHelpers.testClocks.retrieve(id)
    if (status === 'ready') return
    if (status === 'internal_failure') throw new Error(`Horloge ${id} : échec interne chez Stripe.`)
    if (now() - start >= timeoutMs) throw new Error(`Horloge ${id} toujours en cours après ${timeoutMs / 1000} s : réessaie plus tard (status ${status}).`)
    await sleep(2000)
  }
}

const iso = (s) => new Date(s * 1000).toISOString()

async function clockCustomer(stripe, clock) {
  const { data } = await stripe.customers.list({ test_clock: clock, limit: 1 })
  if (!data[0]) throw new Error(`Aucun Customer sur l'horloge ${clock}.`)
  return data[0].id
}

async function clockSubscription(stripe, clock) {
  const { data } = await stripe.subscriptions.list({ customer: await clockCustomer(stripe, clock), limit: 10 })
  const sub = data.find((s) => s.status !== 'canceled' && s.status !== 'incomplete_expired')
  if (!sub) throw new Error(`Aucun abonnement en cours sur l'horloge ${clock}.`)
  return sub
}

const commands = {
  async prices(stripe) {
    const [pro, wb] = await Promise.all([process.env.STRIPE_PRICE_PRO_MONTHLY, process.env.STRIPE_PRICE_WB_2500].map((id) => stripe.prices.retrieve(id)))
    console.log(`pro_monthly ${pro.id} ${pro.unit_amount} ${pro.currency} ${pro.recurring?.interval ?? '-'}`)
    console.log(`wb_2500 ${wb.id} ${wb.unit_amount} ${wb.currency} ${wb.recurring?.interval ?? '-'}`)
    const bad = checkPrices(pro, wb)
    if (bad.length) throw new Error(`Prix différents de lib/shop.ts :\n  ${bad.join('\n  ')}`)
    console.log('Prices conformes à lib/shop.ts.')
  },

  async start(stripe, { uid }) {
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: 'wm-demo' })
    // Imprimé tout de suite : si la suite échoue, `delete --clock` reste possible.
    console.log(`clock ${clock.id}`)
    const customer = await stripe.customers.create({
      test_clock: clock.id,
      metadata: { uid },
      payment_method: 'pm_card_visa',
      invoice_settings: { default_payment_method: 'pm_card_visa' },
    })
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: process.env.STRIPE_PRICE_PRO_MONTHLY }], metadata: { uid } })
    console.log(`customer ${customer.id}\nsubscription ${sub.id}\nstatus ${sub.status}`)
  },

  async advance(stripe, { clock, days }) {
    const c = await stripe.testHelpers.testClocks.retrieve(clock)
    const target = c.frozen_time + days * 86400
    await stripe.testHelpers.testClocks.advance(clock, { frozen_time: target })
    await waitReady(stripe, clock)
    console.log(`clock ${clock}\nstatus ready\nfrozen_time ${iso(target)}`)
  },

  async fail(stripe, { clock }) {
    const customer = await clockCustomer(stripe, clock)
    // Attachée sans débit : la carte n'échoue qu'aux prochains paiements.
    // Le jeton de test donne un vrai PaymentMethod : c'est son id qui devient le défaut.
    const pm = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer })
    await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pm.id } })
    console.log(`clock ${clock}\ncustomer ${customer}\ndefault_payment_method ${pm.id}`)
  },

  async cancel(stripe, { clock }) {
    const sub = await stripe.subscriptions.update((await clockSubscription(stripe, clock)).id, { cancel_at_period_end: true })
    console.log(`clock ${clock}\nsubscription ${sub.id}\nstatus ${sub.status}\ncancel_at_period_end ${sub.cancel_at_period_end}`)
  },

  async delete(stripe, { clock }) {
    const r = await stripe.testHelpers.testClocks.del(clock)
    console.log(`clock ${r.id}\ndeleted ${r.deleted}`)
  },
}

// Valide la commande et ses arguments (aucune clé, aucun réseau) ; rend les arguments propres.
function parse(argv) {
  const [cmd, ...rest] = argv
  if (!Object.hasOwn(commands, cmd ?? '')) throw Object.assign(new Error(cmd ? `Commande inconnue : ${cmd}` : 'Commande absente.'), { usage: true })
  const { values } = parseArgs({ args: rest, options: { uid: { type: 'string' }, clock: { type: 'string' }, days: { type: 'string' } }, strict: true })
  const args = {}
  if (cmd === 'start') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.uid ?? '')) throw new Error('--uid <uuid> requis.')
    args.uid = values.uid
  }
  if (['advance', 'fail', 'cancel', 'delete'].includes(cmd)) {
    if (!/^clock_\w+$/.test(values.clock ?? '')) throw new Error('--clock <id> requis (clock_...).')
    args.clock = values.clock
  }
  if (cmd === 'advance') {
    if (!/^[1-9]\d{0,3}$/.test(values.days ?? '')) throw new Error('--days <n> requis (entier de 1 à 9999).')
    args.days = Number(values.days)
  }
  return { cmd, args }
}

// Variables de Price vérifiées avant tout client : aucune requête n'est partie si l'une manque.
function assertPriceEnv(cmd) {
  const needed = { prices: ['STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_WB_2500'], start: ['STRIPE_PRICE_PRO_MONTHLY'] }[cmd] ?? []
  for (const name of needed) if (!process.env[name]) throw new Error(`${name} absente.`)
}

async function main(argv) {
  try {
    const { cmd, args } = parse(argv)
    // La clé est validée avant la création du client : une clé live ne part jamais.
    const key = assertTestKey(process.env.STRIPE_SECRET_KEY)
    assertPriceEnv(cmd)
    const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION })
    await commands[cmd](stripe, args)
  } catch (e) {
    // Un message du SDK peut citer la clé ou l'e-mail : seuls type, code et statut sont imprimés.
    console.error(e?.type ? `Erreur Stripe : ${e.type} ${e.code ?? ''} (HTTP ${e.statusCode ?? '?'})` : e.message)
    if (e?.usage || e?.code?.startsWith?.('ERR_PARSE_ARGS')) console.error(USAGE)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
