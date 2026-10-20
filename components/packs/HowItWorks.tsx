'use client'

import { CircleHelp, X } from 'lucide-react'
import { useId, useLayoutEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { formatInt } from '@/lib/format'
import { RARITY } from '@/lib/rarity'

// Vues humaines mensuelles de l'article fr.wikipedia (R§5.2, lues dans la modale d'origine).
const MIN_VIEWS = { L: 20_000, UR: 5_000, SR: 1_000, R: 250, PC: 50 } as const

// Modale « Comment ça marche ? » de /pulls (R§2.2) : règles des paquets et seuils de rareté.
export function HowItWorks() {
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
          <div className="mt-5 space-y-6 text-sm leading-relaxed text-[var(--color-foreground)]/80">
            <section className="space-y-2">
              <h3 className="text-base font-bold text-[var(--color-foreground)]">Les paquets</h3>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>Un paquet contient 5 cartes, révélées une à une : la meilleure arrive en dernier.</li>
                <li>Tu gagnes un paquet toutes les 10 minutes (toutes les 3 minutes avec Pro), même hors ligne.</li>
                <li>Ta réserve monte jusqu&apos;à 10 paquets : une fois pleine, elle ne se remplit plus, alors passe les ouvrir.</li>
                <li>Le badge « Nouvelle » marque ta première copie d&apos;une carte. Une Légendaire peut aussi sortir « Brillante » : c&apos;est très rare.</li>
                <li>Membres Pro : un paquet de 15 cartes chaque jour, sans aucune commune.</li>
              </ul>
            </section>
            <section className="space-y-3">
              <h3 className="text-base font-bold text-[var(--color-foreground)]">La rareté</h3>
              <p>Elle dépend du nombre de vues par mois de l&apos;article sur Wikipédia, robots exclus.</p>
              <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
                {RARITY.map((r) => (
                  <li key={r.code} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="tabular-nums text-[var(--color-foreground)]">
                      <span
                        className="mr-1 inline-block min-w-8 rounded-md px-1.5 py-0.5 text-center text-xs font-bold text-[rgb(13,17,23)]"
                        style={{ backgroundColor: `var(--color-rarity-${r.css})` }}
                      >
                        {r.code}
                      </span>{' '}
                      {r.code === 'C' ? `< ${formatInt(MIN_VIEWS.PC)}` : `≥ ${formatInt(MIN_VIEWS[r.code])}`}
                      <span className="text-[var(--color-foreground)]/60"> vues</span>
                    </span>
                    <span className="text-[var(--color-foreground)]/70">{r.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </Modal>
      )}
    </>
  )
}
