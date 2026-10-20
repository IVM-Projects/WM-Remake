import { describe, expect, it } from 'vitest'
import { authErrorMessage } from './auth'

describe('authErrorMessage', () => {
  it('message français du trigger (500 de GoTrue, sans code) → tel quel', () => {
    expect(authErrorMessage({ message: 'Ce pseudo est déjà pris' })).toBe('Ce pseudo est déjà pris')
    expect(authErrorMessage({ message: 'Ce pseudo est réservé', code: 'unexpected_failure' })).toBe('Ce pseudo est réservé')
  })

  it('codes GoTrue connus', () => {
    expect(authErrorMessage({ code: 'email_not_confirmed', message: 'Email not confirmed' }))
      .toBe('Confirme d\'abord ton adresse : saisis le code reçu par courriel.')
    expect(authErrorMessage({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe('Adresse courriel ou mot de passe incorrect.')
  })

  it('codes du projet hébergé (captcha, SMTP non configuré, plafond horaire d\'e-mails, plafond par IP)', () => {
    expect(authErrorMessage({ code: 'captcha_failed', message: 'captcha protection: request disallowed' }))
      .toBe('La vérification anti-bot a échoué, réessaie.')
    expect(authErrorMessage({ code: 'email_address_not_authorized', message: 'Email address not authorized' }))
      .toBe('L\'envoi d\'e-mails n\'est pas encore configuré, réessaie plus tard.')
    expect(authErrorMessage({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }))
      .toBe('Trop d\'e-mails envoyés, réessaie un peu plus tard.')
    expect(authErrorMessage({ code: 'over_request_rate_limit', message: 'Request rate limit reached' }))
      .toBe('Trop de tentatives depuis ce réseau, réessaie dans quelques minutes.')
  })

  it('le reste → message générique (jamais un texte anglais ni une clé héritée)', () => {
    for (const err of [null, {}, { message: 'Database error saving new user' }, { code: 'constructor' }, { code: 'unexpected_failure' }]) {
      expect(authErrorMessage(err)).toBe('Une erreur est survenue, réessaie.')
    }
  })
})
