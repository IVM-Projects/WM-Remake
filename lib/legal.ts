import 'server-only'

export const MISSING = 'à compléter'

// Identité de l'éditeur : variables d'environnement seulement, jamais dans le dépôt.
export function legalInfo(env: Record<string, string | undefined> = process.env) {
  const v = (k: string) => env[k]?.trim() || MISSING
  return {
    publisher: v('LEGAL_PUBLISHER'),
    address: v('LEGAL_ADDRESS'),
    director: v('LEGAL_DIRECTOR'),
    contact: v('LEGAL_CONTACT'),
    host: v('LEGAL_HOST'),
  }
}
