#!/usr/bin/env bash
# Lance OmniRoute (image épinglée OMNIROUTE_IMAGE) en mode self-hosted sur 127.0.0.1:20128 (C14, M5a-7) : un seul
# fournisseur `kind: openai` vers <base_url>, clé PROVIDER_KEY, modèle QUIZ_MODEL. Usage : omniroute.sh <base_url>.
# La clé partagée OMNIROUTE_KEY part dans $GITHUB_ENV, masquée : elle n'existe qu'à partir de l'étape suivante, et tout
# appel à OmniRoute se fait donc dans une étape postérieure à celle-ci.
# Dépôt public : jamais de trace du shell ; la configuration (qui porte la clé) n'est ni imprimée ni écrite sur le disque,
# elle passe au conteneur par son seul nom (-e VAR), pas sur la ligne de commande.
set -euo pipefail

base_url=${1:?usage : omniroute.sh <base_url>}
: "${OMNIROUTE_IMAGE:?}" "${PROVIDER_KEY:?}" "${QUIZ_MODEL:?}" "${GITHUB_ENV:?}"

OMNIROUTE_SELF_HOSTED_API_KEY=$(openssl rand -hex 16)
echo "::add-mask::$OMNIROUTE_SELF_HOSTED_API_KEY"
echo "OMNIROUTE_KEY=$OMNIROUTE_SELF_HOSTED_API_KEY" >> "$GITHUB_ENV"

# JSON est du YAML : format de open-sse/services/routingStrategies.ts (parseSelfHostedRoutingConfig) de la 3.8.51.
# Disjoncteur : 5 échecs d'affilée, 1 s (C12 ; défaut 2 échecs et 30 s, qui couperait un run sur deux 429 passagers).
OMNIROUTE_SELF_HOSTED_PROVIDERS=$(BASE_URL=$base_url node -e '
  const e = process.env
  process.stdout.write(JSON.stringify({
    providers: [{ id: "upstream", kind: "openai", baseUrl: e.BASE_URL, model: e.QUIZ_MODEL, apiKey: e.PROVIDER_KEY }],
    strategy: { cooldown: { consecutiveFailures: 5, cooldownMs: 1000 } },
  }))')
export OMNIROUTE_SELF_HOSTED_PROVIDERS OMNIROUTE_SELF_HOSTED_API_KEY

# Journaux d'appels coupés : OmniRoute y garde sinon les corps (docs/reference/ENVIRONMENT.md:910-932).
cid=$(docker run -d --network host -e REQUIRE_API_KEY=false -e APP_LOG_LEVEL=warn -e ENABLE_REQUEST_LOGS=false \
  -e OMNIROUTE_SELF_HOSTED_PROVIDERS -e OMNIROUTE_SELF_HOSTED_API_KEY "$OMNIROUTE_IMAGE")

deadline=$((SECONDS + 90))
until curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:20128/healthz 2> /dev/null; do
  if ((SECONDS >= deadline)); then
    # Avant toute requête : ces lignes ne peuvent porter ni prompt ni réponse.
    docker logs --tail 100 "$cid"
    echo "::error::OmniRoute : /healthz sans réponse après 90 s"
    exit 1
  fi
  sleep 2
done
echo "OmniRoute prêt en $((SECONDS)) s"
