'use client'

import { HelpDialog } from '@/components/ui/HelpDialog'
import { formatInt } from '@/lib/format'
import { MIN_VIEWS, RARITY } from '@/lib/rarity'

// Modale « Comment ça marche ? » de /pulls (R§2.2) : règles des paquets et seuils de rareté.
export function HowItWorks() {
  return (
    <HelpDialog>
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
    </HelpDialog>
  )
}
