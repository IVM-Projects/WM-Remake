import Link from 'next/link'

const LINK = 'inline-flex min-h-11 items-center font-medium text-accent underline hover:text-accent-light'
const LINKS = [['/credits', 'Crédits'], ['/terms', 'Conditions'], ['/rules', 'Règles'], ['/privacy', 'Confidentialité']] as const

// Dans main et hors de la nav : `nav.hidden a` ne compte que les 13 entrées (R§6.3).
export function Footer() {
  return (
    <footer className="px-4 pb-2 text-xs text-[var(--color-foreground)]/60 md:px-6">
      Projet indépendant de la Fondation Wikimedia
      {LINKS.map(([href, label]) => (
        <span key={href}>
          {' '}·{' '}
          <Link href={href} className={LINK}>
            {label}
          </Link>
        </span>
      ))}
    </footer>
  )
}
