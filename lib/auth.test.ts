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

  it('le reste → message générique (jamais un texte anglais ni une clé héritée)', () => {
    for (const err of [null, {}, { message: 'Database error saving new user' }, { code: 'constructor' }, { code: 'unexpected_failure' }]) {
      expect(authErrorMessage(err)).toBe('Une erreur est survenue, réessaie.')
    }
  })
})
