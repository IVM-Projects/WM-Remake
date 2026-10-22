'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Suspense, type ComponentProps } from 'react'

type Props = ComponentProps<typeof Link> & { href: string; className: string }

// usePathname suspend sous une route au paramètre inconnu du build (/marketplace/[auctionId], use-pathname.md) : repli sans état actif.
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
