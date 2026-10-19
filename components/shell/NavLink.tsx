'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentProps } from 'react'

// Seul morceau client de la barre latérale : le chemin courant ne se lit pas côté serveur.
export function NavLink({ href, className, ...rest }: ComponentProps<typeof Link> & { href: string; className: string }) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`${className} ${active ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'hover:bg-[var(--color-surface-light)]'}`}
      {...rest}
    />
  )
}
