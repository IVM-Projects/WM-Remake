import Link from 'next/link'
import { brand } from '@/lib/brand'

// DOM du logo d'origine (R§6.2) : a[href=/pulls] > h1, préfixe « Wiki » en accent.
export function Logo() {
  return (
    <Link href="/pulls" className="inline-flex min-h-11 items-center rounded-xl">
      <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
        {brand.prefix && <span className="text-[var(--color-accent)]">{brand.prefix}</span>}
        <span className="text-[var(--color-foreground)]">{brand.rest}</span>
      </h1>
    </Link>
  )
}
