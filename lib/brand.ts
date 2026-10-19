// Nom neutre provisoire : la marque d'origine n'est permise que derrière la porte démo.
export const BRAND_DEFAULT = 'WikiCartes'

const ORIGINAL = 'wikimasters'

export function normalizeBrand(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Appelé par next.config.ts (build et démarrage), jamais au niveau module : ce fichier part aussi côté client.
export function assertBrandSafe(name: string, gatePassword: string | undefined): void {
  if (normalizeBrand(name) === ORIGINAL && !gatePassword) {
    throw new Error('Marque d\'origine configurée sans porte démo : définis DEMO_GATE_PASSWORD')
  }
}

export function splitBrand(name: string): { name: string; prefix: string | null; rest: string } {
  return name.startsWith('Wiki')
    ? { name, prefix: 'Wiki', rest: name.slice(4) }
    : { name, prefix: null, rest: name }
}

export const brand = splitBrand(process.env.NEXT_PUBLIC_BRAND_NAME || BRAND_DEFAULT)

export function pageTitle(page: string): string {
  return `${page} — ${brand.name}`
}
