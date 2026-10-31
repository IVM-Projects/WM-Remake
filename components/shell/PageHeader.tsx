import type { LucideIcon } from 'lucide-react'
import type { ReactNode, Ref } from 'react'

// En-tête de page d'origine (R§6.3) : classes du contrat, ne pas renommer. `children` : les actions, à droite.
// ref : le h1, que la page focalise (tabIndex -1) quand le contrôle focalisé disparaît.
export function PageHeader({ title, icon: Icon, children, ref }: { title: string; icon: LucideIcon; children?: ReactNode; ref?: Ref<HTMLHeadingElement> }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 animate-fade-in-up">
      {/* flex-wrap : au téléphone, les actions passent dessous avant que le titre ne casse ; min-w-0 wrap-anywhere : un seul long mot
          (détail d'une enchère) passe à la ligne au lieu d'élargir la page. */}
      <h1 ref={ref} tabIndex={ref ? -1 : undefined} className={`text-2xl md:text-3xl font-bold inline-flex items-center gap-2 min-w-0 wrap-anywhere${ref ? ' outline-none' : ''}`}>
        <Icon className="size-6 shrink-0 text-[var(--color-accent)]" />
        {title}
      </h1>
      {children}
    </div>
  )
}
