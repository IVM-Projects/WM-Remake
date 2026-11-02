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
      updated="2 novembre 2026"
      sections={[
        { id: 'responsable', heading: 'Responsable du traitement', body: (
          <ul className="list-disc space-y-1 pl-5">
            <li>Éditeur : {l.publisher}</li>
            <li>Adresse : {l.address}</li>
            <li>Contact : {l.contact}</li>
          </ul>
        ) },
        { id: 'donnees', heading: 'Données traitées', body: <p>Ton compte (e-mail, pseudo, bio, avatar, réglages), ton jeu (collection, wikibidous, enchères, échanges, batailles, guilde, amis), tes messages, les signalements que tu déposes ou qui te visent, et des journaux techniques où ton identifiant est haché. Si tu paies, voir aussi la section « Paiements et abonnement ».</p> },
        { id: 'finalites', heading: 'Finalités et bases légales', body: <p>Faire fonctionner {brand.name} (exécution du service) ; encaisser tes paiements, gérer ton abonnement et créditer tes achats (exécution du contrat) ; tenir les références de paiement exigées par la comptabilité (obligation légale) ; assurer la modération et lutter contre la fraude (intérêt légitime).</p> },
        { id: 'destinataires', heading: 'Destinataires et sous-traitants', body: (<>
          <p>Tes données sont traitées par des prestataires pour l&apos;hébergement de l&apos;application, la base de données, l&apos;envoi des e-mails et le captcha ; Stripe traite tes paiements (voir « Paiements et abonnement ») ; Wikimédia fournit le catalogue de cartes. Hébergeur : {l.host}.</p>
          <p>Quand un prestataire est hors de l&apos;Union européenne, le transfert est encadré par des clauses contractuelles types.</p>
        </>) },
        { id: 'paiements', heading: 'Paiements et abonnement', body: (
          <ul className="list-disc space-y-2 pl-5">
            <li>Stripe est notre prestataire de paiement. Ta carte est saisie sur la page de Stripe : l&apos;application ne voit ni ne stocke aucun numéro de carte.</li>
            <li>La première fois que tu ouvres un paiement, nous créons ton Customer chez Stripe et lui transmettons ton adresse e-mail et l&apos;identifiant interne de ton compte (pas ton pseudo). Cet identifiant interne accompagne aussi chaque paiement et chaque abonnement, avec des clés techniques anti-doublon construites à partir de lui (et, pour la création du Customer, d&apos;une empreinte tronquée de ton e-mail). Stripe peut utiliser ton e-mail pour t&apos;envoyer des reçus et le lien de connexion à son portail client.</li>
            <li>De notre côté, nous gardons : l&apos;identifiant de ton Customer, tes abonnements (identifiant, tarif souscrit, statut, fin de la période en cours, résiliation prévue, état de la dernière facture) et tes achats (identifiant de la session de paiement, article, montant, devise, date, nombre de wikibidous crédités, et la case des conditions que tu as cochée au paiement).</li>
            <li>Nous gardons aussi les litiges de paiement signalés par Stripe (montant, devise, motif, statut, référence du prélèvement) dans une liste réservée à l&apos;équipe. Ils ne sont pas rattachés à ton compte dans notre base, donc ils ne figurent pas dans ton export.</li>
            <li>Stripe peut traiter ces données en dehors de l&apos;Union européenne, selon ses propres garanties de transfert, décrites dans sa politique de confidentialité.</li>
            <li>Tes abonnements, ton Customer et tes achats figurent dans l&apos;export de tes données (« Mes données », dans les Paramètres), jamais un numéro de carte.</li>
          </ul>
        ) },
        { id: 'conservation', heading: 'Conservation', body: (
          <ul className="list-disc space-y-2 pl-5">
            <li>Ton compte est conservé jusqu&apos;à sa suppression.</li>
            <li>Quand tu supprimes ton compte, ton e-mail, ton pseudo, ta bio et ton avatar sont effacés, ainsi que tes réglages (préférences et notifications), ta collection, tes étiquettes, ta liste de souhaits, tes notifications, tes abonnements push, tes amitiés et tes invitations de guilde. Ton rôle éventuel dans le staff est retiré. Tes enchères et échanges en cours sont annulés, tes batailles en cours aussi (perdues si elles avaient commencé). Si tu diriges une guilde, son membre le plus ancien devient chef ; si tu en es le seul membre, elle est dissoute. Ton ancien pseudo est aussi remplacé dans les notifications des autres joueurs. Ton profil reste comme une coquille anonyme « Joueur supprimé … » qui garde l&apos;historique utile aux autres joueurs et à l&apos;équilibre du jeu : messages, échanges, batailles, signalements, sanctions, mouvements de wikibidous, succès et statistiques.</li>
            <li>Paiements : quand tu supprimes ton compte, nous résilions tout de suite ton abonnement, sans remboursement ; si Stripe est indisponible à ce moment, la suppression aboutit quand même et l&apos;équipe termine la résiliation. Les références de paiement (Customer, abonnements, achats) restent dans notre base, rattachées à ton profil anonyme, pour répondre à nos obligations comptables ; le reste de ton compte est effacé comme décrit plus haut. Nous ne supprimons pas ton Customer chez Stripe : il y garde ton adresse e-mail et l&apos;identifiant interne de ton compte, également pour la comptabilité.</li>
            <li>Les lignes de journal de sécurité propres à ton compte, tenues par notre service d&apos;authentification (inscription, connexions), sont supprimées dans la mesure du possible ; si cette purge échoue, ces lignes peuvent rester.</li>
            <li>Le journal de modération est conservé sans limite de durée tant que le service existe.</li>
            <li>Si tu supprimes ton compte alors que tu es banni, une empreinte (hachage à sens unique, SHA-256) de ton e-mail est gardée tant que le bannissement n&apos;est pas levé par l&apos;équipe, uniquement pour qu&apos;une nouvelle inscription avec la même adresse reste bannie. Aucune empreinte n&apos;est gardée après une suspension, une restriction ou un avertissement.</li>
          </ul>
        ) },
        { id: 'droits', heading: 'Tes droits', body: (
          <ul className="list-disc space-y-2 pl-5">
            <li>Accès et portabilité : télécharge l&apos;export de tes données (« Mes données ») depuis les Paramètres ; il comprend ton Customer Stripe, tes abonnements et tes achats. Il peut être demandé une fois par fenêtre de 10 minutes ; si la réponse se perd, l&apos;export reste bloqué jusqu&apos;à la fin de la fenêtre.</li>
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
