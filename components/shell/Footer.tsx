import Link from 'next/link'

// Dans main et hors de la nav : `nav.hidden a` ne compte que les 13 entrées (R§6.3).
export function Footer() {
  return (
    <footer className="px-4 pb-2 text-xs text-[var(--color-foreground)]/60 md:px-6">
      Projet indépendant de la Fondation Wikimedia ·{' '}
      <Link href="/credits" className="inline-flex min-h-11 items-center font-medium text-accent underline hover:text-accent-light">
        Crédits
      </Link>
    </footer>
  )
}
