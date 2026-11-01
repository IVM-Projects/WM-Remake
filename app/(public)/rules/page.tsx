import type { Metadata } from 'next'
import { LegalPage } from '@/components/legal/LegalPage'
import { legalInfo } from '@/lib/legal'

export const metadata: Metadata = { title: 'Règles de la communauté' }

export default function RulesPage() {
  const l = legalInfo()
  return (
    <LegalPage
      title="Règles de la communauté"
      sections={[
        { id: 'un-compte', heading: 'Un compte par personne', body: <p>Chaque personne a un seul compte. Ouvrir plusieurs comptes pour cumuler des récompenses ou contourner une sanction est interdit.</p> },
        { id: 'automatisation', heading: 'Pas d\'automatisation', body: <p>Les bots, scripts, macros et le trafic modifié sont interdits. Si tu trouves un bug exploitable, signale-le au lieu de l&apos;utiliser.</p> },
        { id: 'triche', heading: 'Pas de triche ni de collusion', body: <p>Tu ne t&apos;entends pas avec d&apos;autres joueurs pour fausser des enchères, des classements, des batailles ou des guildes.</p> },
        { id: 'vente', heading: 'Pas de vente de comptes ni de cartes contre de l\'argent', body: <p>Comptes, cartes et wikibidous ne se vendent ni ne s&apos;achètent contre de l&apos;argent réel.</p> },
        { id: 'respect', heading: 'Respect', body: <p>Les propos haineux, les insultes, le harcèlement, les menaces et la divulgation d&apos;informations personnelles (doxxing) sont interdits, dans les messages comme dans les pseudos, biographies et noms de guilde.</p> },
        { id: 'sensible', heading: 'Contenu Wikipédia sensible', body: <p>Les cartes viennent de Wikipédia et peuvent traiter de sujets sensibles : elles sont informatives. Tu peux activer le filtre des images sensibles dans les Paramètres.</p> },
        { id: 'signaler', heading: 'Signaler', body: <p>Pour signaler un joueur, utilise le bouton de son profil. Pour signaler une image, ouvre la carte et utilise « Signaler l&apos;image ».</p> },
        { id: 'sanctions', heading: 'Sanctions', body: <p>Une sanction peut être prononcée sans préavis. Son motif est tracé, et le staff peut la lever si elle était injustifiée.</p> },
        { id: 'contact', heading: 'Contact', body: <p>Pour toute question ou contestation : {l.contact}.</p> },
      ]}
    />
  )
}
