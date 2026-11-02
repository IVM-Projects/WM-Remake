import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { formatInt } from '@/lib/format'
import { formatPrice, type ShopItem, type ShopState } from '@/lib/shop'
import { ShopOffers } from './ShopOffers'

// Règles de wm.config (Task 1) : 600/180 s, 15 cartes, 5/10 ventes, 3/10 défis, 30 jours, 2 500 wikibidous.
const rules: ShopState['rules'] = {
  pack_size: 5, pack_period_s: { free: 600, pro: 180 }, pro_daily_size: 15, max_concurrent_auctions: { free: 5, pro: 10 },
  battle_quota: { free: 3, pro: 10 }, sales_detail_days: 30, wb_2500: 2500,
}
const sub = { status: 'active', current_period_end: '2026-12-02T00:00:00Z', cancel_at_period_end: false, cancel_at: null }
const state = (me: Partial<ShopState['me']> = {}, maintenance = false): ShopState => ({
  rules,
  me: { balance: 120, is_pro: false, is_vip: false, pack_cap: 10, has_customer: false, subscription: null, ...me },
  purchase: null,
  maintenance,
})
const html = (s: ShopState, extra: { busy?: ShopItem | 'portal' | null; error?: string | null } = {}) =>
  renderToStaticMarkup(<ShopOffers state={s} busy={extra.busy ?? null} error={extra.error ?? null} onBuy={() => {}} onPortal={() => {}} />)
const text = (h: string) => h.replace(/<[^>]*>/g, '|').replace(/\|+/g, '|')
const buttons = (h: string) => h.match(/<button [^>]*>/g) ?? []

test('avantages lus des règles, mot pour mot, et seulement ceux-là', () => {
  const t = text(html(state()))
  for (const line of [
    'Un paquet toutes les 3 minutes au lieu de 10',
    'Un paquet Pro de 15 cartes chaque jour, sans aucune commune',
    '10 ventes en même temps au lieu de 5',
    'L&#x27;historique détaillé des ventes sur 30 jours',
    '10 défis de bataille par jour au lieu de 3',
  ]) expect(t, line).toContain(line)
  expect(html(state()).match(/<li/g)).toHaveLength(5)
})

test('les chiffres suivent la configuration, pas le texte', () => {
  const h = html({ ...state(), rules: { ...rules, pack_period_s: { free: 900, pro: 300 }, pro_daily_size: 20, sales_detail_days: 7, battle_quota: { free: 2, pro: 6 } } })
  expect(h).toContain('Un paquet toutes les 5 minutes au lieu de 15')
  expect(h).toContain('Un paquet Pro de 20 cartes')
  expect(h).toContain('sur 7 jours')
  expect(h).toContain('6 défis de bataille par jour au lieu de 2')
})

test('aucune promesse de meilleures chances', () => {
  for (const s of [state(), state({ is_vip: true }), state({ is_pro: true, subscription: sub }), state({}, true)]) {
    expect(html(s)).not.toMatch(/cote|réserve|chance/i)
  }
})

test('prix par formatPrice, paquet par formatInt, étiquettes qui contiennent le texte visible', () => {
  const h = html(state())
  expect(formatPrice(999)).toContain('9,99')
  expect(formatPrice(499)).toContain('4,99')
  expect(h).toContain(`${formatPrice(999)} par mois`)
  expect(h).toContain(`${formatPrice(499)}, paiement unique`)
  expect(h).toContain(`${formatInt(2500)} wikibidous`)
  expect(h).toContain(`aria-label="S&#x27;abonner à Pro pour ${formatPrice(999)} par mois"`)
  expect(h).toContain(`aria-label="Acheter ${formatInt(2500)} wikibidous pour ${formatPrice(499)}"`)
  expect(h).toContain('Mode test : aucune carte réelle n&#x27;est débitée.')
  expect(h).toContain('tu renonces à ton droit de rétractation')
  expect(h).toMatch(/<a [^>]*href="\/terms"/)
})

test('joueur gratuit : « S\'abonner » et « Acheter », ni statut ni portail', () => {
  const h = html(state())
  expect(buttons(h)).toHaveLength(2)
  expect(h).not.toContain('role="status"')
  expect(h).not.toContain('Gérer mon abonnement')
  expect(h).not.toContain('Tu es membre Pro.')
})

test('Pro accordé par l\'équipe (VIP sans abonnement) : mention, aucun bouton d\'abonnement', () => {
  const h = html(state({ is_vip: true }))
  expect(h).toContain('Avantages Pro accordés par l&#x27;équipe.')
  expect(h).not.toContain('S&#x27;abonner')
  expect(h).not.toContain('Gérer mon abonnement')
  expect(buttons(h)).toHaveLength(1)
})

test('Pro par abonnement : « Tu es membre Pro. » et le portail', () => {
  const h = html(state({ is_pro: true, has_customer: true, subscription: sub }))
  expect(h).toContain('Tu es membre Pro.')
  expect(h).toContain('Gérer mon abonnement')
  expect(h).not.toContain('S&#x27;abonner')
})

test('Pro de fixture sans abonnement ni VIP : l\'offre reste visible', () => {
  const h = html(state({ is_pro: true }))
  expect(h).toContain('S&#x27;abonner')
  expect(h).not.toContain('Tu es membre Pro.')
  expect(h).not.toContain('Avantages Pro accordés')
})

test('maintenance : le statut exact et aria-disabled sur les deux boutons d\'achat', () => {
  const h = html(state({}, true))
  expect(h).toMatch(/<[^>]*role="status"[^>]*>La boutique est fermée pendant la maintenance\.</)
  const disabled = buttons(h).filter((b) => b.includes('aria-disabled="true"'))
  expect(disabled).toHaveLength(2)
  expect(buttons(h).join('')).not.toContain(' disabled')
})

test('envoi en cours : bouton inactif, statut de redirection ; erreur en alerte', () => {
  const sending = html(state(), { busy: 'wb_2500' })
  expect(sending).toMatch(/role="status"[^>]*>Redirection vers le paiement…</)
  expect(buttons(sending).every((b) => b.includes('aria-disabled="true"'))).toBe(true)
  const failed = html(state(), { error: 'Le paiement n\'a pas pu démarrer.' })
  expect(failed).toMatch(/role="alert"[^>]*>Le paiement n&#x27;a pas pu démarrer\.</)
  expect(failed).not.toContain('role="status"')
})
