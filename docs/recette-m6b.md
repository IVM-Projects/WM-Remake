# Recette M6b — boutique, Pro et Stripe (mode test)

Liste à cocher pour tester tout le M6b sur la démo `https://wmr-ivm.vercel.app`. Tout se fait en **mode test Stripe** : aucune vraie carte n'est débitée, aucune entreprise n'est nécessaire.

Règles :
- Ne colle jamais une clé, un secret `whsec_…`, un id `price_…` ni un e-mail de joueur dans la conversation. Donne seulement « fait », « ok » ou « ko » avec ce que tu vois à l'écran.
- « (contrôle MCP) » veut dire que Claude vérifie la base de son côté quand tu lui dis que l'étape est faite.
- Utilise des **comptes de recette neufs** (A, B, C, D…), jamais un compte qui a déjà des achats. Le mot de passe de la porte de démo reste nécessaire.
- Cartes de test : n'importe quelle date future, n'importe quel CVC, n'importe quel code postal.

---

## 0. Réglages (une seule fois)

### 0.1 Stripe Dashboard, mode test

- [ ] Compte Stripe perso créé, interrupteur « Mode test » (ou « Sandbox ») actif.
- [ ] **Produits** : « Abonnement Pro » avec un Price récurrent **mensuel 9,99 CAD** ; « 2 500 wikibidous » avec un Price **unique 4,99 CAD**. Noter les deux `price_…` (hors conversation).
- [ ] **Paramètres → informations publiques** : un nom affiché (ex. « WMR démo ») ; URL des conditions `https://wmr-ivm.vercel.app/terms` ; URL de confidentialité `https://wmr-ivm.vercel.app/privacy`. Sans l'URL des conditions, le Checkout refuse de s'ouvrir.
- [ ] **Facturation → Portail client** :
  - [ ] mise à jour du moyen de paiement : activée
  - [ ] historique des factures : activé
  - [ ] résiliation : activée, **à la fin de la période**
  - [ ] changement d'abonnement : désactivé ; mise à jour des infos client : désactivée
  - [ ] lien de retour par défaut : `https://wmr-ivm.vercel.app/settings`
  - [ ] **lien de connexion au Portail (par e-mail) : activé**
- [ ] **Facturation → Relances (Revenue recovery)** : relances par défaut, puis **résilier l'abonnement** après la dernière tentative.
- [ ] **Développeurs → Webhooks → Ajouter un endpoint** :
  - [ ] URL `https://wmr-ivm.vercel.app/api/stripe/webhook`
  - [ ] type de charge utile **« Snapshot »** (pas « Thin »)
  - [ ] **version d'API `2026-10-28.endive`**
  - [ ] événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.dispute.created`, `charge.dispute.closed`
  - [ ] secret de signature `whsec_…` copié (hors conversation)
- [ ] **Développeurs → Clés API → Clé restreinte** : Checkout Sessions **écriture**, Customer portal **écriture**, Customers **écriture**, Subscriptions **écriture**, Prices **lecture**, Products **lecture**. Valeur `rk_test_…` copiée (hors conversation).

### 0.2 Vercel, projet `wmr`

Production **et** Preview, type **Sensitive** :
- [ ] `STRIPE_SECRET_KEY` = la clé restreinte `rk_test_…`
- [ ] `STRIPE_WEBHOOK_SECRET` = le `whsec_…`
- [ ] `STRIPE_PRICE_PRO_MONTHLY` = le `price_…` de l'abonnement
- [ ] `STRIPE_PRICE_WB_2500` = le `price_…` du paquet
- [ ] **ne pas** créer `STRIPE_API_URL`
- [ ] dire « variables posées » à Claude : il redéploie la production pour que les variables soient prises en compte, puis vérifie la porte du webhook (un `curl` vide doit répondre **400**, pas 401 ni 503).

### 0.3 Premier contrôle de l'endpoint

- [ ] Dashboard → Webhooks → l'endpoint → « Envoyer un événement de test » d'un type quelconque → réponse **200** affichée par Stripe.

---

## 1. Boutique et en-tête (sans payer)

Compte **A** neuf, connecté.

- [ ] L'en-tête montre le solde (pièce + nombre) à côté de la cloche.
- [ ] Clic sur le solde → la modale « Boutique » s'ouvre ; Échap la ferme et le focus revient sur le solde.
- [ ] La modale montre « Abonnement Pro » (9,99 CAD par mois) avec ses avantages, et « 2 500 wikibidous » (4,99 CAD, paiement unique).
- [ ] Les avantages Pro parlent de paquets plus fréquents, du paquet Pro du jour, de ventes simultanées, de l'historique des ventes et des défis de bataille. **Aucune** promesse de meilleures chances ou cotes.
- [ ] Mentions en bas : renonciation au droit de rétractation, lien « Voir les conditions », « Paiement sécurisé par Stripe. Mode test… ».
- [ ] Sur téléphone (ou fenêtre étroite), l'en-tête et la modale restent lisibles sans défilement horizontal.

## 2. Achat de 2 500 wikibidous (carte simple)

Compte **A**.

- [ ] Boutique → « Acheter » → page Stripe Checkout en français.
- [ ] La case des conditions est présente et obligatoire.
- [ ] Carte **4242 4242 4242 4242** → payer.
- [ ] Retour sur `/pulls` : toast « 2 500 wikibidous crédités. » (ou « paiement en cours de confirmation… » puis le crédit dans les secondes qui suivent).
- [ ] Le solde de l'en-tête a gagné **+2 500**, une seule fois.
- [ ] La cloche contient « 2 500 wikibidous crédités ».
- [ ] (contrôle MCP) une ligne d'achat `wb_2500`, une ligne de grand livre `stripe:cs_…`, événement `applied`, invariants `[]`.

## 3. Rejeu d'un webhook (aucun double crédit)

- [ ] Dashboard Stripe → Webhooks → l'événement `checkout.session.completed` de l'étape 2 → « Renvoyer » → Stripe affiche **200**.
- [ ] Recharger la page : le solde de A n'a **pas** bougé.
- [ ] (contrôle MCP) toujours une seule ligne `stripe:cs_…`, l'événement compté une fois, invariants `[]`.

## 4. 3-D Secure et carte refusée

Compte **A**.

- [ ] Acheter 2 500 WB avec **4000 0027 6000 3184** → la fenêtre 3-D Secure s'ouvre → « Autoriser » → crédité de +2 500.
- [ ] Acheter 2 500 WB avec **4000 0000 0000 0002** → Stripe refuse la carte → **aucun** crédit, aucune notification.
- [ ] « Annuler » / retour depuis la page Stripe → la modale de la boutique se rouvre avec « Paiement annulé : rien n'a été débité. ».

## 5. Abonnement Pro

Compte **A**.

- [ ] Boutique → « S'abonner » → Checkout → carte **4242…** → payer.
- [ ] Retour : toast « Bienvenue chez les membres Pro ! ».
- [ ] Pastille **PRO** violette à côté du solde.
- [ ] `/pulls` : le bloc « Pro du jour » propose « Récupérer » → 15 cartes, aucune commune.
- [ ] `/pulls` : « Comment ça marche ? » indique un paquet toutes les 3 minutes pour Pro.
- [ ] Le prochain paquet régénère en 3 minutes (au lieu de 10) quand le stock n'est pas plein.
- [ ] Une carte → onglet « Marché » : l'historique détaillé des ventes est visible (plus de « Fonction réservée aux membres Pro »).
- [ ] Batailles : la limite de défis du jour est plus haute qu'en gratuit.
- [ ] La boutique affiche « Tu es membre Pro. » et « Gérer mon abonnement ».
- [ ] Un second « S'abonner » est impossible (la boutique renvoie vers le Portail).
- [ ] `/settings` → section « Abonnement » : « Abonnement Pro actif. Prochain renouvellement le … » (date dans environ un mois).
- [ ] Cloche : « Tu es membre Pro … ».
- [ ] (contrôle MCP) abonnement `active` avec une date de fin de période renseignée, `is_pro` vrai, consentement `accepted`, événement `applied`.

## 6. Portail client et résiliation en fin de période

Compte **A**.

- [ ] `/settings` → « Gérer mon abonnement » → Portail Stripe.
- [ ] Dans le Portail : « Annuler l'abonnement » → confirmer → revenir sur le site.
- [ ] `/settings` : « Abonnement Pro résilié : tu restes Pro jusqu'au … ».
- [ ] La pastille PRO est toujours là (Pro jusqu'à la fin de la période payée).
- [ ] (contrôle MCP) `cancel_at_period_end` vrai, `is_pro` vrai.

## 7. Lien de connexion au Portail par e-mail

- [ ] Ouvrir le lien de connexion du Portail client (Dashboard → Portail client → lien de connexion) dans une fenêtre privée, saisir l'e-mail du compte A, recevoir l'e-mail (en mode test : visible côté Stripe / boîte du compte) et accéder au Portail **sans** passer par le site.
- [ ] Noter « ok » ou « ko » : c'est ce que `/terms` promet à un compte suspendu ou banni.

## 8. Horloges de test (renouvellement, échec de paiement, fin d'abonnement)

Sur **ton** ordinateur, dans un clone du dépôt, avec ta **clé secrète de test `sk_test_…`** (celle du Dashboard, jamais dans Vercel ni dans la conversation) posée seulement dans ton terminal : `export STRIPE_SECRET_KEY=sk_test_…`, plus `STRIPE_PRICE_PRO_MONTHLY` et `STRIPE_PRICE_WB_2500`. Chaque horloge utilise **un compte de démo neuf** ; ne supprime jamais dans le Dashboard un Customer lié à un joueur.

- [ ] `node scripts/stripe-clock.mjs prices` → sortie 0 (les Prices du Dashboard correspondent aux montants de la boutique).

Compte **B** neuf (son identifiant de joueur : demande-le à Claude, il le lit par le MCP à partir du nom du compte).
- [ ] `node scripts/stripe-clock.mjs start --uid <id de B>` → note l'id d'horloge affiché ; B devient Pro (pastille).
- [ ] `node scripts/stripe-clock.mjs advance --clock <id> --days 32` → renouvellement payé ; B reste Pro ; `/settings` montre une date reculée d'un mois.
- [ ] `node scripts/stripe-clock.mjs fail --clock <id>` puis `advance --clock <id> --days 32` → paiement échoué : Pro retiré ; cloche « Le paiement de ton abonnement Pro a échoué » et « Ton abonnement Pro est suspendu : mets à jour ton moyen de paiement » ; `/settings` « Le dernier paiement a échoué… ».
- [ ] `node scripts/stripe-clock.mjs delete --clock <id>`.
- [ ] (contrôle MCP) `invoice.paid` puis `invoice.payment_failed` appliqués, statut `past_due`, invariants `[]`.

Compte **D** neuf, seconde horloge.
- [ ] `start --uid <id de D>` → Pro.
- [ ] `cancel --clock <id>` puis `advance --clock <id> --days 32` → abonnement terminé : Pro retiré, cloche « Ton abonnement Pro est terminé ».
- [ ] `delete --clock <id>`.
- [ ] Noter pour chaque commande : sortie 0 ou le message d'erreur.

## 9. Suppression d'un compte abonné

Compte **C** neuf.

- [ ] S'abonner à Pro avec **4242…**.
- [ ] `/settings` → « Supprimer mon compte » : la modale annonce « Ton abonnement Pro sera résilié tout de suite, sans remboursement. ».
- [ ] Confirmer → déconnexion, retour à la connexion.
- [ ] Dashboard Stripe : l'abonnement de C est **annulé**.
- [ ] (contrôle MCP) abonnement `canceled` (webhook `deleted` reçu), pas de résiliation en attente pour C, invariants `[]`.

## 10. Litige

- [ ] Acheter 2 500 WB (compte A ou un compte neuf) avec la **carte de litige** de la page des cartes de test Stripe (section « Disputes » de docs.stripe.com/testing ; à vérifier là-bas).
- [ ] Compte staff → `/admin` : tuile « Litiges Stripe ouverts » à 1 et le litige dans la liste avec son lien « Voir dans Stripe ».

## 11. Fonctions verrouillées et liens vers l'abonnement (compte gratuit)

Compte gratuit neuf.

- [ ] `/pulls` à 0 paquet : « Avec Pro, un paquet revient toutes les 3 minutes. » et « Voir l'abonnement » → ouvre la boutique.
- [ ] Bloc « Pro du jour » : « Réservé aux membres Pro » + « Voir l'abonnement ».
- [ ] Carte → onglet Marché → « Fonction réservée aux membres Pro » + « Voir l'abonnement ».
- [ ] Batailles : quota épuisé → « Voir l'abonnement ».
- [ ] « Comment ça marche ? » affiche les vrais chiffres (paquet toutes les 10 minutes en gratuit, réserve, taille du Pro du jour).

## 12. Paramètres, admin et pages légales

- [ ] Compte gratuit sans abonnement → `/settings` : « Tu n'as pas d'abonnement. » + « Voir l'abonnement ».
- [ ] Compte staff (admin) → `/admin` : tuiles « Litiges Stripe ouverts » et, s'il y en a, « Résiliations Stripe en attente » / « Achats sur comptes supprimés ».
- [ ] Compte modérateur → `/admin` : pas de bouton « Résilier ».
- [ ] `/terms` : section « Abonnement Pro » (prix, renouvellement mensuel, résiliation par le Portail en fin de période, suspension si paiement échoué, résiliation à la suppression du compte, litiges, mode test), « Dernière mise à jour : 2 novembre 2026 », « Version du 2026-11-02 ».
- [ ] `/privacy` : section paiements (Stripe nommé, aucun numéro de carte vu ni stocké, e-mail et identifiant interne transmis à Stripe, données gardées après suppression pour la comptabilité, données dans « Mes données »).
- [ ] `/settings` → « Mes données » (export) : le fichier contient l'abonnement et les achats du compte, aucune carte.

## 13. Après la recette

- [ ] Dire à Claude « recette finie » avec la liste des « ko » éventuels : il consigne les preuves (ids et statuts seulement) dans `docs/verifications.md`, clôt la ligne M6 de D:1085 dans la passation, et archive l'espace de travail.
- [ ] Faits Stripe à confirmer sur docs.stripe.com au passage (la session de développement n'y avait pas accès) : la carte de litige ; que `pm_card_chargeCustomerFail` s'attache puis échoue au débit ; le message de Stripe quand on résilie un abonnement déjà résilié ; les réglages du Portail (fin de période, lien de connexion).
- [ ] Relecture humaine de `/terms` et `/privacy` avant toute ouverture publique (ce n'est pas un conseil juridique) ; les valeurs `LEGAL_*` sont à compléter.
