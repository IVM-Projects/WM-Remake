import type { ReactNode, Ref } from 'react'
import { FormError } from '@/components/auth/Field'
import { ghost } from '@/components/ui/button'

// Section d'une page de réglages (/settings, /profile), nommée par son titre. Le titre est focalisable (tabIndex -1) : il prend le focus
// quand « Réessayer » disparaît. ref : le titre, pour une page sans id fixe (ids de useId). ready : data-ready, une fois la section lue.
export function Section({ id, title, ref, ready, children }: {
  id: string
  title: string
  ref?: Ref<HTMLHeadingElement>
  ready?: boolean
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} data-ready={ready ? '' : undefined} className="card-frame space-y-4 p-6">
      <h2 ref={ref} id={id} tabIndex={-1} className="text-lg font-bold outline-none">{title}</h2>
      {children}
    </section>
  )
}

// Lecture d'une section en échec : le message en alerte et « Réessayer ».
export function ReadError({ onRetry, children }: { onRetry: () => void; children: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FormError>{children}</FormError>
      <button type="button" onClick={onRetry} className={`${ghost} justify-center gap-2 self-start`}>Réessayer</button>
    </div>
  )
}
