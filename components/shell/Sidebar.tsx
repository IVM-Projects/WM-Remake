import { NAV } from './nav'
import { NavLink } from './NavLink'

// Classes de la nav et des liens relevées sur l'original (R§6.3) : contrat des extensions, ne pas renommer.
export function Sidebar() {
  return (
    <nav
      aria-label="Navigation principale"
      className="hidden w-64 shrink-0 flex-col gap-2 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] p-6 md:flex"
    >
      {NAV.map(({ href, label, icon: Icon }) => (
        <NavLink key={href} href={href} className="group flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors">
          <Icon className="size-5 shrink-0" />
          <span className="flex-1">{label}</span>
          <span className="size-1.5 rounded-full bg-[var(--color-accent)] invisible group-aria-[current=page]:visible" />
        </NavLink>
      ))}
    </nav>
  )
}
