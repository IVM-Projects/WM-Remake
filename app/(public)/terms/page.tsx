import type { Metadata } from 'next'
import Link from 'next/link'
import { linkClass } from '@/components/auth/Field'
import { LegalPage } from '@/components/legal/LegalPage'
import { TERMS_VERSION } from '@/lib/auth'
import { brand } from '@/lib/brand'
import { legalInfo } from '@/lib/legal'

export const metadata: Metadata = { title: 'Conditions d\'utilisation' }

export default function TermsPage() {
  const l = legalInfo()
  return (
    <LegalPage
      title="Conditions d'utilisation"
      sections={[
        { id: 'objet', heading: 'Objet du service', body: <p>{brand.name} est un jeu de collection de cartes tirées d&apos;articles de Wikipédia : tu ouvres des paquets, tu échanges, tu enchéris et tu te mesures aux autres joueurs. Ces conditions encadrent ton usage du service.</p> },
        { id: 'inscription', heading: 'Inscription', body: <p>Tu dois avoir 18 ans ou plus. Un compte correspond à une seule personne : tu ne le partages pas et tu n&apos;en ouvres pas un second. Tu es responsable de ton mot de passe et de ce qui se fait depuis ton compte.</p> },
        { id: 'cartes', heading: 'Cartes et contenu Wikipédia', body: (<>
          <p>Le texte des cartes provient de Wikipédia et reste sous licence CC BY-SA 4.0 ; les images restent sous la licence indiquée sur Wikimedia Commons. Ce contenu peut être sensible : il est informatif et ne reflète pas nos opinions.</p>
          <p>Les auteurs et licences sont détaillés sur la page <Link href="/credits" className={linkClass}>Crédits</Link>.</p>
        </>) },
        { id: 'biens-virtuels', heading: 'Biens virtuels', body: <p>Les wikibidous et les cartes n&apos;ont aucune valeur monétaire. Tu ne peux pas les échanger contre de l&apos;argent en dehors du jeu, ni les vendre ou les acheter ailleurs que dans {brand.name}.</p> },
        { id: 'achats', heading: 'Achats', body: <p>Un achat est définitif. Pour un contenu numérique fourni tout de suite, tu renonces à ton droit de rétractation au moment du paiement. Tant que l&apos;éditeur ne l&apos;a pas levé, le service reste en mode test : aucun paiement réel n&apos;est demandé.</p> },
        { id: 'interdits', heading: 'Comportements interdits', body: <p>Les comportements interdits (automatisation, triche, vente de comptes, harcèlement…) sont détaillés dans les <Link href="/rules" className={linkClass}>Règles de la communauté</Link>, qui font partie de ces conditions.</p> },
        { id: 'moderation', heading: 'Modération et sanctions', body: <p>L&apos;équipe peut prononcer un avertissement, une restriction, une suspension ou un bannissement, et retirer des cartes du jeu. Chaque décision est enregistrée avec son motif dans un journal réservé au staff.</p> },
        { id: 'suppression', heading: 'Suppression du compte', body: <p>Tu peux supprimer ton compte à tout moment, immédiatement, depuis les Paramètres. Ce qui est effacé et ce qui est conservé est expliqué dans la <Link href="/privacy" className={linkClass}>politique de confidentialité</Link>.</p> },
        { id: 'responsabilite', heading: 'Responsabilité et disponibilité', body: <p>Le service est fourni tel quel, sans garantie de disponibilité continue : il peut être interrompu pour maintenance ou évolution. Dans la mesure permise par la loi, l&apos;éditeur n&apos;est pas responsable des dommages indirects liés à l&apos;usage du jeu.</p> },
        { id: 'mentions', heading: 'Mentions légales', body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>Éditeur : {l.publisher}</li>
            <li>Adresse : {l.address}</li>
            <li>Directeur de la publication : {l.director}</li>
            <li>Contact : {l.contact}</li>
            <li>Hébergeur : {l.host}</li>
          </ul>
        ) },
        { id: 'version', heading: 'Version', body: <p>Version du {TERMS_VERSION}.</p> },
      ]}
    />
  )
}
