import Link from 'next/link'
import type { ReactNode } from 'react'
import { linkClass } from '@/components/auth/Field'

export type LegalSection = { id: string; heading: string; body: ReactNode }

const FOOT = [['/terms', 'Conditions d\'utilisation'], ['/rules', 'Règles de la communauté'], ['/privacy', 'Confidentialité'], ['/credits', 'Crédits']] as const

export function LegalPage({ title, sections }: { title: string; sections: LegalSection[] }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <article className="card-frame w-full max-w-prose space-y-4 p-6 motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-sm text-foreground/70">Dernière mise à jour : 31 octobre 2026</p>
        <nav aria-label="Sommaire">
          <ul className="space-y-1 text-sm">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className={linkClass}>{s.heading}</a>
              </li>
            ))}
          </ul>
        </nav>
        {sections.map((s) => (
          <section key={s.id} id={s.id} tabIndex={-1} aria-labelledby={`${s.id}-h`} className="space-y-2 text-sm wrap-anywhere focus:outline-none">
            <h2 id={`${s.id}-h`} className="text-lg font-semibold">{s.heading}</h2>
            {s.body}
          </section>
        ))}
        <footer className="flex flex-wrap gap-x-4 border-t border-foreground/10 pt-2">
          {FOOT.map(([href, label]) => (
            <Link key={href} href={href} className={linkClass}>{label}</Link>
          ))}
        </footer>
      </article>
    </main>
  )
}
