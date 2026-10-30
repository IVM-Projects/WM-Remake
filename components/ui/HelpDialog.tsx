'use client'

import { CircleHelp, X } from 'lucide-react'
import { useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { Modal } from '@/components/ui/Modal'

// Bouton « Comment ça marche ? » et sa modale (C17) : /pulls (HowItWorks) et /battle y posent leurs règles.
export function HelpDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  // Page quittée puis gardée par Activity (Cache Components) : on ne la retrouve pas avec l'aide ouverte.
  useLayoutEffect(() => () => setOpen(false), [])

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium text-[var(--color-foreground)]/80 transition-colors hover:bg-[var(--color-surface-light)] hover:text-[var(--color-foreground)]"
      >
        <CircleHelp className="size-5" />
        Comment ça marche ?
      </button>
      {open && (
        <Modal
          onClose={() => setOpen(false)}
          labelledBy={id}
          className="card-frame relative w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 animate-fade-in-up"
        >
          <button
            type="button"
            // Pas « Fermer » seul : c'est le sélecteur d'extension du bouton de la modale de carte (R§6.8).
            aria-label="Fermer l'aide"
            onClick={() => setOpen(false)}
            className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-[var(--color-surface-light)]"
          >
            <X className="size-6" />
          </button>
          <h2 id={id} className="pr-10 text-xl font-bold">Comment ça marche ?</h2>
          <div className="mt-5 space-y-6 text-sm leading-relaxed text-[var(--color-foreground)]/80">{children}</div>
        </Modal>
      )}
    </>
  )
}
