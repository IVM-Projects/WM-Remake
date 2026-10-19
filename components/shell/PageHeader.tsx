import type { LucideIcon } from 'lucide-react'
import type { NavEntry } from './nav'

// En-tête de page d'origine (R§6.3) : classes du contrat, ne pas renommer.
export function PageHeader({ title, icon: Icon }: { title: string; icon: LucideIcon }) {
  return (
    <div className="flex items-start justify-between gap-4 animate-fade-in-up">
      <h1 className="text-2xl md:text-3xl font-bold inline-flex items-center gap-2">
        <Icon className="size-6 shrink-0 text-[var(--color-accent)]" />
        {title}
      </h1>
    </div>
  )
}

// Page d'attente d'une section, remplacée à son jalon.
export function ComingSoon({ entry }: { entry: NavEntry }) {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <PageHeader title={entry.title} icon={entry.icon} />
      <p className="text-sm text-[var(--color-foreground)]/60">Cette section arrive bientôt.</p>
    </div>
  )
}
