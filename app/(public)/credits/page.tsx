import type { Metadata } from 'next'
import { formatInt } from '@/lib/format'
import { MIN_VIEWS, RARITY } from '@/lib/rarity'

export const metadata: Metadata = { title: 'Crédits' }

const link = 'font-medium text-accent underline hover:text-accent-light'

// Sources, licences et méthode des statistiques (M2-16) ; pas de liste des images : chaque fiche de carte porte son crédit.
export default function CreditsPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="card-frame w-full max-w-prose space-y-4 p-6 text-sm motion-safe:animate-fade-in-up">
        <h1 className="text-2xl font-bold">Crédits et licences</h1>
        <h2 className="text-lg font-bold">Sources</h2>
        <p>
          Les textes des cartes sont des extraits abrégés d&apos;articles de Wikipédia en français, sous licence{' '}
          <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.fr" target="_blank" rel="noopener noreferrer" className={link}>
            CC BY-SA 4.0
          </a>
          .
        </p>
        <p>
          Les descriptions courtes viennent de Wikidata, sous licence{' '}
          <a href="https://creativecommons.org/publicdomain/zero/1.0/deed.fr" target="_blank" rel="noopener noreferrer" className={link}>
            CC0
          </a>
          .
        </p>
        <p>Les images viennent de Wikimedia Commons : l&apos;auteur et la licence de chaque image sont indiqués dans la fiche de la carte.</p>
        <h2 className="text-lg font-bold">Statistiques des cartes</h2>
        <p>La rareté dépend des vues humaines de l&apos;article sur Wikipédia pendant le mois civil précédent :</p>
        <ul className="list-disc space-y-1 pl-5">
          {RARITY.map(({ code }) => (
            <li key={code}>
              {code === 'C' ? `C : moins de ${formatInt(MIN_VIEWS.PC)}` : `${code} : ${formatInt(MIN_VIEWS[code])} vues ou plus`}
            </li>
          ))}
        </ul>
        <p>
          ATK, DEF et Q-Score suivent la méthode stats_v1. Chaque article est classé parmi tout le catalogue selon la longueur de son
          texte et selon ses liens entrants, les autres articles qui pointent vers lui.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>ATK : de {formatInt(1000)} pour le texte le plus court à {formatInt(10000)} pour le plus long.</li>
          <li>
            Q-Score, sur 100 : 45 % pour le rang de la longueur du texte, 35 % pour celui des liens entrants et 20 % pour le label
            « Article de qualité » (20 points) ou « Bon article » (12 points).
          </li>
          <li>DEF : de {formatInt(1000)} pour le Q-Score le plus bas à {formatInt(10000)} pour le plus haut.</li>
        </ul>
        <p>Sur la démo, le catalogue est un échantillon proportionnel de chaque rareté : les totaux affichés sont ceux des cartes chargées.</p>
        <p>Projet indépendant de la Fondation Wikimedia.</p>
      </div>
    </main>
  )
}
