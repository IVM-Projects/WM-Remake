// Version des CGU acceptée à l'inscription, lue par le trigger wm.handle_new_user.
export const TERMS_VERSION = '2026-10-19'

// Refus du trigger d'inscription : GoTrue relaie le message de wm.raise_err, sauf appelé avec X-Supabase-Api-Version (supabase-js).
const KNOWN = new Set([
  'Pseudo invalide (3 à 24 caractères)',
  'Ce pseudo est réservé',
  'Ce pseudo est déjà pris',
  'Confirme avoir au moins 18 ans et accepte les conditions.',
])

// Codes d'erreur GoTrue des parcours d'authentification ; Map et non objet : pas de clé héritée (`constructor`).
const BY_CODE = new Map([
  ['email_not_confirmed', 'Confirme d\'abord ton adresse : saisis le code reçu par courriel.'],
  ['invalid_credentials', 'Adresse courriel ou mot de passe incorrect.'],
  ['otp_expired', 'Code invalide ou expiré.'],
  ['weak_password', 'Mot de passe trop faible.'],
  ['same_password', 'Choisis un mot de passe différent de l\'ancien.'],
  ['over_email_send_rate_limit', 'Trop d\'e-mails envoyés, réessaie dans une minute.'],
])

export function authErrorMessage(err: { message?: string; code?: string } | null): string {
  if (err?.message && KNOWN.has(err.message)) return err.message
  return BY_CODE.get(err?.code ?? '') ?? 'Une erreur est survenue, réessaie.'
}
