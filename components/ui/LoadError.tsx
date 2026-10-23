import type { Ref } from 'react'
import { ghost } from '@/components/ui/button'

// Lecture en échec d'une page (P19) : le message en alerte et « Réessayer ». ref : le bouton, que la page focalise quand il revient.
export function LoadError({ onRetry, ref, text = 'Impossible de charger cette page.' }: { onRetry: () => void; ref?: Ref<HTMLButtonElement>; text?: string }) {
  return (
    <div className="card-frame mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center">
      <p role="alert" className="text-sm">{text}</p>
      <button ref={ref} type="button" onClick={onRetry} className={`${ghost} justify-center`}>
        Réessayer
      </button>
    </div>
  )
}
