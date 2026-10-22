'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Suspense, type ComponentProps } from 'react'

type Props = ComponentProps<typeof Link> & { href: string; className: string }

// Seul morceau client de la barre latérale : le chemin courant ne se lit pas côté serveur. Sous une route au paramètre inconnu du build
// (/marketplace/[auctionId]), usePathname suspend : la coquille statique rend le lien sans état actif, qui arrive avec la requête
// (use-pathname.md, « Cache Components »). Ailleurs, le chemin est connu au prérendu et le repli n'est jamais rendu.
export function NavLink(props: Props) {
  return (
    <Suspense fallback={<Item {...props} active={false} />}>
      <Current {...props} />
    </Suspense>
  )
}

function Current(props: Props) {
  const pathname = usePathname()
  return <Item {...props} active={pathname === props.href || pathname.startsWith(`${props.href}/`)} />
}

function Item({ href, className, active, ...rest }: Props & { active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`${className} ${active ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'hover:bg-[var(--color-surface-light)]'}`}
      {...rest}
    />
  )
}
