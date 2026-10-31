import type { Metadata } from 'next'
import { LegalPage } from '@/components/legal/LegalPage'
import { brand } from '@/lib/brand'
import { legalInfo } from '@/lib/legal'

export const metadata: Metadata = { title: 'Politique de confidentialité' }

export default function PrivacyPage() {
  const l = legalInfo()
  return (
    <LegalPage
      title="Politique de confidentialité"
      sections={[
        { id: 'responsable', heading: 'Responsable du traitement', body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>Éditeur : {l.publisher}</li>
            <li>Adresse : {l.address}</li>
            <li>Contact : {l.contact}</li>
          </ul>
        ) },
        { id: 'donnees', heading: 'Données traitées', body: <p>Ton compte (e-mail, pseudo, bio, avatar, réglages), ton jeu (collection, wikibidous, enchères, échanges, batailles, guilde, amis), tes messages, les signalements que tu déposes ou qui te visent, et des journaux techniques où ton identifiant est haché.</p> },
        { id: 'finalites', heading: 'Finalités et bases légales', body: <p>Faire fonctionner {brand.name} (exécution du service) ; assurer la modération et lutter contre la fraude (intérêt légitime).</p> },
        { id: 'destinataires', heading: 'Destinataires et sous-traitants', body: (<>
          <p>Tes données sont traitées par des prestataires pour l&apos;hébergement de l&apos;application, la base de données, l&apos;envoi des e-mails et le captcha ; Wikimédia fournit le catalogue de cartes. Hébergeur : {l.host}.</p>
          <p>Quand un prestataire est hors de l&apos;Union européenne, le transfert est encadré par des clauses contractuelles types.</p>
        </>) },
        { id: 'conservation', heading: 'Conservation', body: (
          <ul className="list-disc space-y-2 pl-5">
            <li>Ton compte est conservé jusqu&apos;à sa suppression.</li>
            <li>Quand tu supprimes ton compte, ton e-mail, tes données d&apos;identité (pseudo, bio, avatar) et tes réglages personnels sont effacés, ainsi que ta collection, tes amis et tes notifications. L&apos;historique de jeu reste, pseudonymisé sous « Joueur supprimé … » : messages, échanges, batailles, signalements, sanctions et mouvements de wikibidous, nécessaires aux autres joueurs et à l&apos;équilibre du jeu.</li>
            <li>Les lignes de journal de sécurité propres à ton compte, tenues par notre service d&apos;authentification, sont supprimées dans la mesure du possible.</li>
            <li>Le journal de modération est conservé sans limite de durée tant que le service existe.</li>
            <li>Si tu supprimes ton compte alors que tu es banni, une empreinte (hachage à sens unique, SHA-256) de ton e-mail est gardée tant que le bannissement dure, uniquement pour qu&apos;une nouvelle inscription avec la même adresse reste bannie. Aucune empreinte n&apos;est gardée après une suspension, une restriction ou un avertissement.</li>
          </ul>
        ) },
        { id: 'droits', heading: 'Tes droits', body: (
          <ul className="list-disc space-y-2 pl-5">
            <li>Accès et portabilité : télécharge l&apos;export de tes données depuis les Paramètres. Il peut être demandé une fois par fenêtre de 10 minutes ; si la réponse se perd, l&apos;export reste bloqué jusqu&apos;à la fin de la fenêtre.</li>
            <li>Rectification : modifie ton pseudo et ta bio dans les Paramètres.</li>
            <li>Effacement : supprime ton compte depuis les Paramètres.</li>
            <li>Limitation et opposition : écris-nous à {l.contact}.</li>
            <li>Si ton compte est suspendu ou banni, tu ne peux plus te connecter : demande ton export ou la suppression de ton compte à {l.contact}, pas depuis les Paramètres.</li>
            <li>Tu peux aussi adresser une réclamation à la CNIL (cnil.fr).</li>
          </ul>
        ) },
        { id: 'cookies', heading: 'Cookies', body: <p>Nous utilisons uniquement des cookies strictement nécessaires : ta session et la porte de démo. Aucun traceur, donc aucun bandeau.</p> },
        { id: 'push', heading: 'Notifications push', body: <p>Elles ne sont envoyées qu&apos;avec ton consentement, appareil par appareil, et tu peux les couper à tout moment.</p> },
        { id: 'modifications', heading: 'Modifications', body: <p>Cette politique peut évoluer ; la date de dernière mise à jour figure en haut de la page.</p> },
      ]}
    />
  )
}
