import { describe, expect, it } from 'vitest'
import { statusText } from '@/components/settings/Subscription'
import type { ShopState } from '@/lib/shop'

// Midi UTC : le jour ne change dans aucun fuseau d'usage.
const END = '2027-03-15T12:00:00Z'
const me = (subscription: Partial<NonNullable<ShopState['me']['subscription']>> | null, is_vip = false): ShopState['me'] => ({
  balance: 0, is_pro: false, is_vip, pack_cap: 0, has_customer: true,
  subscription: subscription && { status: 'active', current_period_end: END, cancel_at_period_end: false, cancel_at: null, ...subscription },
})
const NONE = 'Tu n\'as pas d\'abonnement.'
const VIP = 'Avantages Pro accordés par l\'équipe.'
const PAST_DUE = 'Le dernier paiement a échoué : ton abonnement Pro est suspendu. Mets à jour ton moyen de paiement.'
const INACTIVE = 'Ton abonnement Pro n\'est pas actif pour l\'instant.'

describe('Subscription statusText', () => {
  it('active et trialing : prochain renouvellement, date en français', () => {
    for (const status of ['active', 'trialing']) expect(statusText(me({ status })), status).toBe('Abonnement Pro actif. Prochain renouvellement le 15 mars 2027.')
  })

  it('fin de période d\'un abonnement résilié : « tu restes Pro jusqu\'au … »', () => {
    expect(statusText(me({ cancel_at_period_end: true }))).toBe('Abonnement Pro résilié : tu restes Pro jusqu\'au 15 mars 2027.')
    expect(statusText(me({ status: 'trialing', cancel_at_period_end: true }))).toBe('Abonnement Pro résilié : tu restes Pro jusqu\'au 15 mars 2027.')
  })

  it('cancel_at posé sans cancel_at_period_end : résilié, jusqu\'à la date de cancel_at (pas de renouvellement annoncé)', () => {
    const at = '2027-02-10T12:00:00Z'
    expect(statusText(me({ cancel_at: at }))).toBe('Abonnement Pro résilié : tu restes Pro jusqu\'au 10 février 2027.')
    expect(statusText(me({ cancel_at: at, cancel_at_period_end: true }))).toBe('Abonnement Pro résilié : tu restes Pro jusqu\'au 10 février 2027.')
    expect(statusText(me({ cancel_at: at, current_period_end: null }))).toBe('Abonnement Pro résilié : tu restes Pro jusqu\'au 10 février 2027.')
  })

  it('date absente ou illisible : la phrase tient sans date', () => {
    for (const current_period_end of [null, 'pas une date']) {
      expect(statusText(me({ current_period_end }))).toBe('Abonnement Pro actif.')
      expect(statusText(me({ current_period_end, cancel_at_period_end: true }))).toBe('Abonnement Pro résilié : tu restes Pro jusqu\'à la fin de la période.')
    }
  })

  it('past_due et unpaid : paiement échoué, même résilié en fin de période', () => {
    for (const status of ['past_due', 'unpaid']) {
      expect(statusText(me({ status })), status).toBe(PAST_DUE)
      expect(statusText(me({ status, cancel_at_period_end: true })), status).toBe(PAST_DUE)
    }
  })

  it('incomplete et paused : la phrase neutre', () => {
    for (const status of ['incomplete', 'paused']) expect(statusText(me({ status })), status).toBe(INACTIVE)
  })

  it('terminé ou absent : aucun abonnement, ou les avantages de l\'équipe pour un VIP', () => {
    for (const s of [null, { status: 'canceled' }, { status: 'incomplete_expired' }]) {
      expect(statusText(me(s))).toBe(NONE)
      expect(statusText(me(s, true))).toBe(VIP)
    }
  })

  it('VIP avec un abonnement non terminal : l\'abonnement prime', () => {
    expect(statusText(me({ status: 'active' }, true))).toBe('Abonnement Pro actif. Prochain renouvellement le 15 mars 2027.')
    expect(statusText(me({ status: 'past_due' }, true))).toBe(PAST_DUE)
    expect(statusText(me({ status: 'paused' }, true))).toBe(INACTIVE)
  })
})
