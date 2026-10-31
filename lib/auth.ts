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
  // Aussi le plafond horaire du projet (SMTP personnalisé) : pas « dans une minute ».
  ['over_email_send_rate_limit', 'Trop d\'e-mails envoyés, réessaie un peu plus tard.'],
  // Projet hébergé : clés Turnstile dépareillées ou jeton déjà servi ; SMTP pas encore configuré (l'expéditeur intégré ne sert que l'organisation).
  ['captcha_failed', 'La vérification anti-bot a échoué, réessaie.'],
  ['email_address_not_authorized', 'L\'envoi d\'e-mails n\'est pas encore configuré, réessaie plus tard.'],
  // Plafond par IP du projet hébergé (/token, /signup, /verify) : toute une salle derrière un même NAT l'atteint ensemble.
  ['over_request_rate_limit', 'Trop de tentatives depuis ce réseau, réessaie dans quelques minutes.'],
  // Compte suspendu ou banni (inféré) : GoTrue refuse le jeton, le code est celui de la route de sanction.
  ['user_banned', 'Ce compte est suspendu. Contacte l\'équipe par l\'adresse indiquée dans la politique de confidentialité.'],
])

// sessionStorage et non l'URL (/verify-email?email=…) : l'adresse resterait dans les journaux de requêtes et l'historique.
export const VERIFY_EMAIL_KEY = 'wm.verifyEmail'

export function authErrorMessage(err: { message?: string; code?: string } | null): string {
  if (err?.message && KNOWN.has(err.message)) return err.message
  return BY_CODE.get(err?.code ?? '') ?? 'Une erreur est survenue, réessaie.'
}

// Vérification préalable (inscription, paramètres) : message de refus du pseudo (réservé, pris, invalide), ou null s'il est libre.
export async function usernameProblem(u: string): Promise<string | null> {
  const body = (await (await fetch(`/api/username-available?u=${encodeURIComponent(u)}`)).json()) as { available?: boolean; error?: string }
  return body.available === false ? body.error ?? null : null
}
