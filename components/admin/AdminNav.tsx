'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { StaffRole } from './types'

const ITEMS = [
  ['/admin', 'Tableau de bord'], ['/admin/reports', 'Signalements'], ['/admin/users', 'Joueurs'], ['/admin/cards', 'Cartes'],
  ['/admin/guilds', 'Guildes'], ['/admin/audit', 'Journal'],
] as const

// Sous-menu de l'espace staff : un nav sans la classe `hidden`, donc hors du compte des 13 entrées de `nav.hidden a`.
export function AdminNav({ role }: { role: StaffRole }) {
  const pathname = usePathname()
  return (
    <div className="space-y-2">
      <nav aria-label="Administration" className="flex flex-wrap gap-2">
        {ITEMS.map(([href, label]) => {
          const on = href === '/admin' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)
          return (
            <Link
              key={href}
              href={href}
              aria-current={on ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-xl border px-4 text-sm font-medium transition-colors ${on
                ? 'border-[var(--color-accent)] bg-[var(--color-surface-light)] text-[var(--color-accent)]'
                : 'border-[var(--color-foreground)]/40 hover:bg-[var(--color-surface-light)]'}`}
            >
              {label}
            </Link>
          )
        })}
      </nav>
      <p className="text-sm text-[var(--color-foreground)]/70">{role === 'admin' ? 'Rôle : administrateur' : 'Rôle : modérateur'}</p>
    </div>
  )
}
