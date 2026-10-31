#!/usr/bin/env bash
# Modération et suppression de compte en parallèle (joueurs, pierres tombales comprises, guildes et cartes du tag supprimées à la sortie,
# config image_reports restaurée). Derrière un bloqueur, l'attente est prouvée (gabarit de 20_guilds_concurrency.test.sh). « D'abord » :
# l'appel est lancé, puis attendu en attente d'un verrou avant le suivant. Chaque scénario : aucun 40P01 ni 55P03, chaque appel servi ou
# refusé par un message exact, check_invariants() = [] (dont market_money, reservation, escrow, pool_removed, deleted_account).
# 1. Retrait contre mise : enchère de S sur X, mise de M ; l'enchère tenue, place_bid(N) d'abord, puis le retrait → la mise passe (M
#    remboursé), puis le retrait dénoue l'enchère et rembourse N ; la copie revient à S.
# 2. Retrait contre règlement : vente échue de X avec mise, lot tenu 1 s après son règlement, puis le retrait → settled_sold, une seule
#    ligne settle: ou refund:.
# 3. Retrait contre acceptation d'échange : échange A → B d'une copie de X ; l'échange tenu, accept d'abord → accepted, la copie chez B.
# 4. Retrait contre don de guilde : souhait de B sur X ; le souhait tenu, guild_donate(A) d'abord → donné, aucun souhait ouvert.
# 5. Deux retraits de X (l'enchère de X tenue) → un {"ok": true}, un 409 « Cette carte est déjà retirée », une ligne d'audit card_remove.
# 6. Suppression contre règlement de vente : M < D, D vendeur d'une vente échue avec la mise de M ; M tenu, le lot d'abord (il tient la
#    vente), puis account_delete(D) → settled_sold (WB chez D, copie chez M), puis la suppression.
# 7. Suppression contre surenchère : D meneur sur la vente de S ; la vente tenue, place_bid(N) d'abord → D remboursé une fois, N meneur.
# 8. Suppression contre acceptation d'échange : échange D ↔ E ; l'échange tenu, accept d'abord → accepted, puis la collection de D effacée.
# 9. Suppression contre fin de bataille : KO de D contre F à la dernière réponse ; la bataille tenue, la fin d'abord → finie une fois, deux
#    lignes battle:<id>.
# 10. Suppression contre départ du successeur : D chef, H seul autre membre ; la guilde tenue, guild_leave(H) puis la suppression, et
#     l'inverse → servis ; la guilde dissoute ou dirigée par H, jamais sans chef avec un membre.
# 11. Seuil d'image à 5 : la carte tenue, 10 signalements → hide_image, une ligne image_auto_hide, 10 signalements.
# 12. Double sanction, même p_idem, deux sessions → la seconde servie après 0,5 s au même corps, une sanction, une ligne d'audit.
# 13. Création d'engagement contre suppression (G1) : D tenu, create_trade(E, D) d'abord, puis account_delete(D) → 503 BUSY sans rien
#     écrire, puis relancée : l'échange cancelled, une trade_voided chez E ; même gabarit avec create_auction(D).
# 14. Retrait contre suppression du vendeur, 10 tours : D vendeur d'une vente de X (mise de M) et auteur d'un échange qui offre une copie
#     de X ; l'échange tenu, la suppression ou le retrait d'abord (en alternance) → dénoués une seule fois.
# 15. Retrait contre créations (G6) : S tenu (une copie de X en vitrine), create_auction, guild_wish_set et create_trade de S sur X
#     d'abord, puis le retrait → servis ; le retrait relève ses engagements avant le profil : la vente, le souhait et l'échange créés
#     survivent au retrait (accepté par G6), la vitrine est vidée.
# 16. Suppression contre guild_wish_set du même joueur : D tenu, wish_set(D) d'abord, puis la suppression → 503 BUSY, puis relancée
#     servie ; sans souhait antérieur, puis avec un souhait remplacé.
# 17. Successeur tardif : D chef seul ; la guilde tenue, guild_join(J) d'abord, puis la suppression → 503 BUSY, puis relancée : J chef.
# 18. Sanction contre suppression : D tenu, la suppression puis le bannissement → 404 « Joueur introuvable » sous le verrou, sans
#     empreinte ; l'inverse → le bannissement posé, puis l'empreinte d'e-mail écrite par la suppression.
# 19. Retrait d'ami contre suppression : A ↔ B amis, échange A → B en attente ; l'amitié tenue, friend_remove(B) d'abord, puis
#     account_delete(A) → servis, aucun 40P01 (la suppression prend l'amitié avant l'échange, comme friend_remove) ; l'échange annulé.
# 20. Requêtes en vol du compte supprimé : la suppression de D tenue 2 s avant son commit, open_pack(D), place_bid(D) (D n'est pas meneur)
#     et guild_create(D) d'abord → 401 « Session expirée » relu sous le verrou du profil ; aucune copie, mise ni guilde pour la pierre tombale.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="mod_$RANDOM$RANDOM"
cfg="$(q -c "select value from wm.config where key = 'image_reports'")"
cleanup() {
  wait  # appels encore en vol après un échec : rien n'est supprimé sous eux
  # Les joueurs par leurs ids (une pierre tombale a perdu son pseudo du tag) ; la garde des pierres tombales levée pour la session. Le pool
  # et les retraits d'abord (clés NO ACTION vers public.cards), puis les guildes du tag (une guilde survit à ses membres, et ses dons
  # retiennent les profils), l'audit, les empreintes et les clés d'idempotence (sans clé étrangère), puis les joueurs, leurs copies,
  # ventes, échanges et batailles avec eux, puis les cartes.
  q -c "update wm.config set value = '$cfg' where key = 'image_reports'" >/dev/null  # d'abord : un delete en échec ne la laisse pas
  local ids cards="select id from public.cards where wikipedia_title like '$tag %'"
  ids="{$(paste -sd, "$tmp/users" 2>/dev/null || true)}"
  q -c "select set_config('wm.allow_tombstone_delete', 'on', false)" \
    -c "select wm.pool_remove(id) from public.cards where wikipedia_title like '$tag %'" \
    -c "delete from wm.card_removals where card_id in ($cards)" \
    -c "delete from public.guilds where id in (select guild_id from public.guild_members where user_id = any ('$ids'::uuid[]))
      or leader_id = any ('$ids'::uuid[])" \
    -c "delete from wm.staff_actions where staff_id = any ('$ids'::uuid[]) or target_id = any ('$ids'::text[])
      or target_id in (select id::text from public.cards where wikipedia_title like '$tag %')" \
    -c "delete from wm.banned_emails where user_id = any ('$ids'::uuid[])" \
    -c "delete from wm.idempotency_keys where user_id = any ('$ids'::uuid[])" \
    -c "delete from auth.users where id = any ('$ids'::uuid[])" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "$1" >&2; shift; (( $# == 0 )) || cat "$@" >&2; exit 1; }  # $2… : sorties d'erreur à montrer

# Joueur « ${tag}_$1 » au solde $2 (0 par défaut), noté pour le nettoyage. trader : vérifié (marché).
player() { local u; u="$(q -c "select tests.make_user('${tag}_$1', ${2:-0})")"; echo "$u" >>"$tmp/users"; echo "$u"; }
trader() { local u; u="$(player "$@")"; q -c "select wm.set_human_verified('$u')" >/dev/null; echo "$u"; }
# Carte R du tag au pool, titrée « $tag $1 », ATK $2 et DEF $3 (1 000 et 800 par défaut) ; k = nombre de cartes du tag déjà créées. Rend
# son id (pool_add, void, n'imprime qu'une ligne vide, que $(…) retire).
card() {
  q -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, pageviews)
    select '$tag $1', 'https://fr.wikipedia.org/wiki/${tag}_$1', 'R', ${2:-1000}, ${3:-800}, round(100 * 1.2 ^ (count(*) % 60))::int
    from public.cards where wikipedia_title like '$tag %' returning id" \
    -c "select wm.pool_add(id, rarity) from public.cards where wikipedia_title = '$tag $1'"
}
# Appels en arrière-plan, SQLSTATE dans les erreurs (VERBOSITY verbose) : $1 = fichier d'erreurs, puis la requête.
pids=()
bg() { q -v VERBOSITY=verbose -c "set role service_role; $2" >/dev/null 2>"$tmp/$1" & pids+=($!); }
# Même chose, la sortie gardée dans $tmp/$1.out.
bgo() { q -v VERBOSITY=verbose -c "set role service_role; $2" >"$tmp/$1.out" 2>"$tmp/$1" & pids+=($!); }
waitall() { fails=0; for p in "${pids[@]}"; do wait "$p" || fails=$((fails + 1)); done; pids=(); }
# Aucun interblocage ni attente de verrou échue ; chaque sortie d'erreur non vide des fichiers $2… contient un refus du motif $1.
refusals() {
  local pat="$1"; shift
  ! grep -qE '40P01|55P03' "$@" || fail "interblocage ou verrou échu" $(grep -lE '40P01|55P03' "$@")
  for f in "$@"; do [[ ! -s $f ]] || grep -qE "$pat" "$f" || fail "refus inattendu dans ${f##*/}" "$f"; done
}
# Aucune erreur ni aucun avertissement.
quiet() { for f in "$@"; do [[ ! -s $f ]] || fail "sortie d'erreur dans ${f##*/}" "$f"; done; }
# Attend le PgSleep du bloqueur ; mort avant, il échoue avec sa sortie d'erreur $1, si elle est donnée.
sleeping() {
  until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do
    kill -0 "$blocker" 2>/dev/null || fail "bloqueur mort avant son PgSleep" ${1:+"$1"}
  done
}
# Bloqueur $1 : prend $2 (un perform … for update) et le tient jusqu'à ce que $3 appels de bg attendent un verrou, 1 s au plus après le premier
# vu (la moitié du lock_timeout : chaque appel attend donc ~1 s plus la vidange, même si les connexions arrivent lentement), 5 s au plus en
# tout ; puis imprime le nombre maximal vu en attente. Rendu dès son premier PgSleep, avant le lancement des appels.
hold() {
  cat >"$tmp/$1.sql" <<SQL
begin;
do \$\$ declare n int; m int := 0; t timestamptz; t1 timestamptz := clock_timestamp(); begin
  $2;
  loop
    perform pg_stat_clear_snapshot();  -- sinon pg_stat_activity reste figé pour toute la transaction
    n := (select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'set role service_role;%');
    m := greatest(m, n);
    if t is null and n > 0 then t := clock_timestamp(); end if;
    exit when n >= $3 or clock_timestamp() > t + interval '1 second' or clock_timestamp() > t1 + interval '5 seconds';
    perform pg_sleep(0.05);
  end loop;
  perform set_config('wm_test.max_waiters', m::text, true);
end \$\$;
select current_setting('wm_test.max_waiters');
commit;
SQL
  q -f "$tmp/$1.sql" >"$tmp/$1.out" 2>"$tmp/$1.err" &
  blocker=$!
  sleeping "$tmp/$1.err"
}
# Fin du bloqueur $1 : au moins $2 appels vus en attente. La contention est prouvée, même si, sur un runner lent, quelques appels partent
# après la libération.
released() {
  wait "$blocker" || fail "bloqueur $1 en erreur" "$tmp/$1.err"
  local max; max="$(cat "$tmp/$1.out")"
  echo "21_moderation_concurrency : $1 : $max appels au plus en attente derrière le bloqueur" >&2
  (( max >= $2 )) || fail "$1 : contention insuffisante, $max appels en attente ($2 au moins)"
  (( max >= 2 )) || echo "21_moderation_concurrency : $1 : avertissement, un seul appel vu en attente" >&2
}
ms() { echo $(( (${EPOCHREALTIME/[.,]/} - ${t0/[.,]/}) / 1000 )); }  # depuis t0=$EPOCHREALTIME
deck() { echo "jsonb_build_object('card_ids', array['$1', '$2', '$3'])"; }
# k1 (ATK 1 000) à k3 pour A, k4 à k6 (DEF 300, Σ 900) pour B : trois mauvaises réponses à l'attaque de k1 font un KO.
kc=("$(card k1 1000 500)" "$(card k2 400 500)" "$(card k3 400 500)" "$(card k4 400 300)" "$(card k5 400 300)" "$(card k6 400 300)")
# Partie active de $1 (A, challenger, à qui revient l'attaque) contre $2 (B), amis. Rend son id.
live() {
  local x
  x="$(q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$1', '$2', 'accepted')" \
    -c "select from unnest(array['${kc[0]}', '${kc[1]}', '${kc[2]}']::uuid[]) u, wm.grant_copy('$1', u, false)" \
    -c "select from unnest(array['${kc[3]}', '${kc[4]}', '${kc[5]}']::uuid[]) u, wm.grant_copy('$2', u, false)" \
    -c "select wm.battle_create('$1', '$2') ->> 'id'")"
  q -c "select wm.battle_action('$2', '$x', 'accept')" \
    -c "select wm.battle_action('$1', '$x', 'submit_deck', $(deck "${kc[0]}" "${kc[1]}" "${kc[2]}"))" \
    -c "select wm.battle_action('$2', '$x', 'submit_deck', $(deck "${kc[3]}" "${kc[4]}" "${kc[5]}"))" >/dev/null
  echo "$x"
}
# Question $2 (1 à 3) de l'attaque en cours de la bataille $1 et sa plus petite mauvaise option, « question option ».
wrong() {
  q -c "select (e ->> 'id') || ' ' || (select min(o ->> 'id') from jsonb_array_elements(e -> 'options') o where o ->> 'id' <> s.correct_option_id)
    from public.battles t, jsonb_array_elements(t.game_state #> '{pendingAttack,questions}') with ordinality u (e, i), wm.battle_secrets s
    where t.id = '$1' and u.i = $2 and s.battle_id = t.id and s.question_id = (e ->> 'id')::uuid"
}
# La même partie à la dernière question d'un KO : A attaque avec k1, B a mal répondu aux deux premières. Rend « bataille question option »,
# l'option fausse.
ko() {
  local x i qq oo
  x="$(live "$1" "$2")"
  q -c "select wm.battle_action('$1', '$x', 'submit_attack', jsonb_build_object('attack_card_id', '${kc[0]}'))" >/dev/null
  for i in 1 2; do
    read -r qq oo <<<"$(wrong "$x" "$i")"
    q -c "select wm.battle_action('$2', '$x', 'submit_single_answer', jsonb_build_object('questionId', '$qq', 'answerId', '$oo'))" >/dev/null
  done
  echo "$x $(wrong "$x" 3)"
}
reply() { echo "select wm.battle_action('$2', '$1', 'submit_single_answer', jsonb_build_object('questionId', '$3', 'answerId', '$4'))"; }
waiting() { q -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'set role service_role;%'"; }
# La fin de $1 (A, gagnant) contre $2 (B) : pose bt (la bataille) et fin (la dernière réponse de B).
end_of() { local q3 o3; read -r bt q3 o3 <<<"$(ko "$1" "$2")"; fin="$(reply "$bt" "$2" "$q3" "$o3")"; }
# Lance $2 par bg (fichier $1), puis attend que ${3:-1} appels attendent un verrou avant de rendre la main.
first() {
  bg "$1" "$2"
  local p="${pids[-1]}"
  until (( $(waiting) >= ${3:-1} )); do
    kill -0 "$p" 2>/dev/null || fail "$1 jamais en attente d'un verrou" "$tmp/$1"
    sleep 0.05
  done
}
# Transaction tenue ${3:-1} s après $2 (fichier d'erreurs $1) ; rendu à son PgSleep.
held() {
  q -v VERBOSITY=verbose -c "begin; $2; select pg_sleep(${3:-1}); commit;" >/dev/null 2>"$tmp/$1" &
  blocker=$!
  sleeping "$tmp/$1"
}
# Guilde de chef $1 et de membres $2…, rend son id.
guild() {
  local g u
  g="$(q -c "select wm.guild_create('$1', '$tag') #>> '{guild,id}'")"
  shift
  for u in "$@"; do q -c "insert into public.guild_members (guild_id, user_id) values ('$g', '$u')" >/dev/null; done
  echo "$g"
}
friends() { q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$1', '$2', 'accepted')" >/dev/null; }
grant() { q -c "select (wm.grant_copy('$1', '$2', false)).id"; }
copy() { q -c "select id from public.user_cards where user_id = '$1' and card_id = '$2' order by id limit 1"; }
owns() { q -c "select coalesce(sum(count), 0) from public.user_cards where user_id = '$1' and card_id = '$2'"; }
wish() { q -c "select wm.guild_wish_set('$1', '$2') #>> '{wishlist,id}'"; }
open_wishes() { q -c "select count(*) from public.guild_wishlists where user_id = '$1' and fulfilled_at is null"; }
member() { q -c "select count(*) from public.guild_members where user_id = '$1'"; }
# Vente de $1 d'une copie neuve de la carte $2, mise de départ 10, 60 min ; rend son id.
auction() { q -c "select wm.create_auction('$1', (wm.grant_copy('$1', '$2', false)).id, 10, 60) ->> 'auction_id'"; }
bid() { q -c "select wm.place_bid('$1', '$2', $3)" >/dev/null; }
due() { q -c "update public.auctions set end_at = now() - interval '1 second' where id = '$1'" >/dev/null; }
# Échange de $1 à $2 offrant les copies $3… de $1 ; rend son id.
trade() {
  local from="$1" to="$2" items; shift 2
  items="$(printf "jsonb_build_object('user_card_id', '%s', 'offered_by', '$from')," "$@")"
  q -c "select wm.create_trade('$from', '$to', jsonb_build_array(${items%,})) ->> 'id'"
}
astatus() { q -c "select status from public.auctions where id = '$1'"; }
tstatus() { q -c "select status from public.trades where id = '$1'"; }
bal() { q -c "select wikibidous_balance from public.profiles where id = '$1'"; }
# Lignes refund de $1 sur les mises de la vente $2.
refunds() { q -c "select count(*) from wm.wb_ledger l join public.auction_bids b on l.ref = 'refund:' || b.id
  where b.auction_id = '$2' and l.user_id = '$1' and l.reason = 'refund'"; }
deleted() { q -c "select count(*) from wm.deleted_accounts where user_id = '$1'"; }
voided() { q -c "select count(*) from public.notifications where user_id = '$1' and type = '$2' and data ->> '$3_id' = '$4'"; }
inv() { q -c "select wm.check_invariants()"; }
# Deux joueurs, « petit grand » dans l'ordre des id ; $3 : solde.
pair() { local x y; x="$(trader "$1" "${3:-0}")"; y="$(trader "$2" "${3:-0}")"; q -c "select least('$x'::uuid, '$y') || ' ' || greatest('$x'::uuid, '$y')"; }

adm="$(player adm)"
q -c "insert into wm.staff (user_id, role) values ('$adm', 'admin')" >/dev/null
remove() { echo "select wm.admin_card_remove('$adm', '$1', 'retrait de test')"; }
del() { echo "select wm.account_delete('$1', '$(q -c "select username from public.profiles where id = '$1'")')"; }
busy="^ERROR:  P0001: Le site est très sollicité, réessaie dans un instant\.$"
# Un seul refus 503 BUSY dans le fichier $1.
is_busy() { [[ "$(grep -c "$busy" "$1") $(grep -c '"code": "BUSY"' "$1") $(grep -c '"status": 503' "$1")" == "1 1 1" ]] || fail "$2 : 503 BUSY attendu" "$1"; }

# 1. Retrait contre mise : la mise tient l'enchère, puis le miseur et l'ancien meneur ; le retrait attend l'enchère (ordre C4) sans tenir
# de profil, puis relit le meneur sous son verrou. lock_users avant les enchères, le retrait tiendrait M en attendant l'enchère, que la mise
# tient en attendant M (40P01).
s="$(trader 1s)"; m="$(trader 1m 100)"; n="$(trader 1n 100)"
x="$(card x1)"
a="$(auction "$s" "$x")"
bid "$m" "$a" 10
hold s1 "perform from public.auctions where id = '$a' for update" 2
first 1b "select wm.place_bid('$n', '$a', 20)"
bg 1r "$(remove "$x")"
released s1 1
waitall
refusals . "$tmp/1b" "$tmp/1r"
quiet "$tmp/1b" "$tmp/1r"
got="$(astatus "$a") $(bal "$m") $(bal "$n") $(refunds "$m" "$a") $(refunds "$n" "$a") $(owns "$s" "$x") $(inv)"
[[ $got == "cancelled 100 100 1 1 1 []" ]] || fail "retrait contre mise : statut, soldes de M et N, refunds de M et N, copie de S, invariants : $got"

# 2. Retrait contre règlement : le lot tient la vente et les profils jusqu'à son commit ; le retrait attend la vente, puis la relit réglée
# (for update relit status = 'active').
s="$(trader 2s)"; m="$(trader 2m 100)"
x="$(card x2)"
a="$(auction "$s" "$x")"
bid "$m" "$a" 10
due "$a"
held 2s "select wm.settle_due_auctions(500)"
bg 2r "$(remove "$x")"
wait "$blocker" || fail "retrait contre règlement : lot en erreur" "$tmp/2s"
waitall
refusals . "$tmp/2s" "$tmp/2r"
quiet "$tmp/2s" "$tmp/2r"
got="$(astatus "$a") $(q -c "select count(*) from wm.wb_ledger where reason = 'settle' and ref = 'settle:$a'") $(refunds "$m" "$a") \
$(owns "$m" "$x") $(inv)"
[[ $got == "settled_sold 1 0 1 []" ]] || fail "retrait contre règlement : statut, lignes settle, refund, copie de M, invariants : $got"

# 3. Retrait contre acceptation d'échange : l'acceptation tient l'échange ; le retrait l'attend, puis le relit accepted.
a1="$(player 3a)"; b1="$(player 3b)"
friends "$a1" "$b1"
x="$(card x3)"
t="$(trade "$a1" "$b1" "$(grant "$a1" "$x")")"
hold s3 "perform from public.trades where id = '$t' for update" 2
first 3t "select wm.trade_action('$b1', '$t', 'accept')"
bg 3r "$(remove "$x")"
released s3 1
waitall
refusals . "$tmp/3t" "$tmp/3r"
quiet "$tmp/3t" "$tmp/3r"
got="$(tstatus "$t") $(owns "$a1" "$x") $(owns "$b1" "$x") $(inv)"
[[ $got == "accepted 0 1 []" ]] || fail "retrait contre échange : statut, copies de A et B, invariants : $got"

# 4. Retrait contre don : le don tient le souhait ; le retrait l'attend, puis le relit clos.
a1="$(player 4a)"; b1="$(player 4b)"; l="$(player 4l)"
g="$(guild "$l" "$a1" "$b1")"
x="$(card x4)"
c1="$(grant "$a1" "$x")"
w="$(wish "$b1" "$x")"
hold s4 "perform from public.guild_wishlists where id = '$w' for update" 2
first 4d "select wm.guild_donate('$a1', '$w', '$c1')"
bg 4r "$(remove "$x")"
released s4 1
waitall
refusals . "$tmp/4d" "$tmp/4r"
quiet "$tmp/4d" "$tmp/4r"
got="$(q -c "select count(*) from public.guild_donations where wishlist_id = '$w'") $(owns "$b1" "$x") $(open_wishes "$b1") $(inv)"
[[ $got == "1 1 0 []" ]] || fail "retrait contre don : dons, copie de B, souhaits ouverts de B, invariants : $got"

# 5. Deux retraits : le premier insère sa ligne card_removals, puis attend l'enchère tenue ; le second attend cette insertion, puis la
# trouve validée (409).
s="$(trader 5s)"
x="$(card x5)"
a="$(auction "$s" "$x")"
hold s5 "perform from public.auctions where id = '$a' for update" 2
for k in 1 2; do bgo "5-$k" "$(remove "$x")"; done
released s5 1
waitall
refusals 'Cette carte est déjà retirée' "$tmp/5-1" "$tmp/5-2"
got="$(cat "$tmp/5-1.out" "$tmp/5-2.out" | grep -c '"ok": true') $(cat "$tmp/5-1" "$tmp/5-2" | grep -c '^ERROR:  P0001: Cette carte est déjà retirée$') \
$(cat "$tmp/5-1" "$tmp/5-2" | grep -c '"status": 409') $(q -c "select count(*) from wm.staff_actions where action = 'card_remove' and target_id = '$x'") \
$(astatus "$a") $(inv)"
[[ $got == "1 1 1 1 cancelled []" ]] || fail "deux retraits : succès, refus, refus 409, lignes d'audit, statut, invariants : $got"

# 6. Suppression contre règlement : M < D, M tenu ; le lot prend la vente (skip locked), puis attend M ; la suppression attend la vente,
# sans tenir de profil, puis la relit réglée. lock_users avant les enchères, la suppression tiendrait D en attendant la vente, que le lot
# tient en attendant D (40P01).
read -r m d <<<"$(pair 6a 6b 100)"
x="$(card x6)"
a="$(auction "$d" "$x")"
bid "$m" "$a" 10
due "$a"
hold s6 "perform from public.profiles where id = '$m' for update" 2
first 6s "select wm.settle_due_auctions(500)"
bg 6d "$(del "$d")"
released s6 1
waitall
refusals . "$tmp/6s" "$tmp/6d"
quiet "$tmp/6s" "$tmp/6d"
got="$(astatus "$a") $(owns "$m" "$x") $(q -c "select count(*) from wm.wb_ledger where user_id = '$d' and reason = 'settle' and ref = 'settle:$a'") \
$(bal "$d") $(deleted "$d") $(inv)"
[[ $got == "settled_sold 1 1 110 1 []" ]] || fail "suppression contre règlement : statut, copie de M, ligne settle de D, solde de D, supprimé, invariants : $got"

# 7. Suppression contre surenchère : la mise tient la vente ; la suppression l'attend, puis relit le meneur (for update relit la condition) :
# D n'y est plus, rien à dénouer.
s="$(trader 7s)"; d="$(trader 7d 100)"; n="$(trader 7n 100)"
x="$(card x7)"
a="$(auction "$s" "$x")"
bid "$d" "$a" 10
hold s7 "perform from public.auctions where id = '$a' for update" 2
first 7b "select wm.place_bid('$n', '$a', 20)"
bg 7d "$(del "$d")"
released s7 1
waitall
refusals . "$tmp/7b" "$tmp/7d"
quiet "$tmp/7b" "$tmp/7d"
got="$(q -c "select status || ' ' || (current_bidder_id = '$n') from public.auctions where id = '$a'") $(bal "$d") $(refunds "$d" "$a") \
$(deleted "$d") $(inv)"
[[ $got == "active true 100 1 1 []" ]] || fail "suppression contre surenchère : statut, N meneur, solde de D, refunds de D, supprimé, invariants : $got"

# 8. Suppression contre acceptation d'échange : l'acceptation tient l'échange, puis les deux profils ; la suppression attend l'échange sans
# tenir de profil. Profils pris avant les échanges, elle tiendrait D en attendant l'échange, que l'acceptation tient en attendant D (40P01).
d="$(player 8d)"; e="$(player 8e)"
friends "$d" "$e"
x="$(card x8)"; y="$(card y8)"
cx="$(grant "$d" "$x")"; cy="$(grant "$e" "$y")"
t="$(q -c "select wm.create_trade('$d', '$e', jsonb_build_array(jsonb_build_object('user_card_id', '$cx', 'offered_by', '$d'),
  jsonb_build_object('user_card_id', '$cy', 'offered_by', '$e'))) ->> 'id'")"
hold s8 "perform from public.trades where id = '$t' for update" 2
first 8t "select wm.trade_action('$e', '$t', 'accept')"
bg 8d "$(del "$d")"
released s8 1
waitall
refusals . "$tmp/8t" "$tmp/8d"
quiet "$tmp/8t" "$tmp/8d"
got="$(tstatus "$t") $(q -c "select count(*) from public.user_cards where user_id = '$d'") $(owns "$e" "$x") $(owns "$e" "$y") $(deleted "$d") $(inv)"
[[ $got == "accepted 0 1 0 1 []" ]] || fail "suppression contre échange : statut, copies de D, X et Y chez E, supprimé, invariants : $got"

# 9. Suppression contre fin de bataille : la fin tient la bataille ; la suppression l'attend, puis la relit completed.
d="$(player 9d)"; f="$(player 9f)"
end_of "$d" "$f"
hold s9 "perform from public.battles where id = '$bt' for update" 2
first 9e "$fin"
bg 9d "$(del "$d")"
released s9 1
waitall
refusals . "$tmp/9e" "$tmp/9d"
quiet "$tmp/9e" "$tmp/9d"
got="$(q -c "select status || ' ' || (winner_id = '$d') from public.battles where id = '$bt'") \
$(q -c "select count(*) from wm.wb_ledger where reason = 'battle' and ref = 'battle:$bt'") $(deleted "$d") $(inv)"
[[ $got == "completed true 2 1 []" ]] || fail "suppression contre fin de bataille : statut, D vainqueur, lignes battle, supprimé, invariants : $got"

# 10. Suppression contre départ du successeur : la guilde sérialise les deux. Départ d'abord : plus de successeur, guilde dissoute. Suppression
# d'abord : H chef seul, son départ dissout la guilde. Jamais une guilde sans chef avec un membre.
for pass in depart suppression; do
  d="$(player "10d${pass:0:1}")"; h="$(player "10h${pass:0:1}")"
  g="$(guild "$d" "$h")"
  hold "s10$pass" "perform from public.guilds where id = '$g' for no key update" 2
  if [[ $pass == depart ]]; then
    first "10l$pass" "select wm.guild_leave('$h')"; bg "10d$pass" "$(del "$d")"
  else
    first "10d$pass" "$(del "$d")"; bg "10l$pass" "select wm.guild_leave('$h')"
  fi
  released "s10$pass" 1
  waitall
  refusals . "$tmp/10l$pass" "$tmp/10d$pass"
  quiet "$tmp/10l$pass" "$tmp/10d$pass"
  got="$(q -c "select coalesce((select (leader_id = '$h')::text from public.guilds where id = '$g'), 'dissoute')") $(member "$h") \
$(q -c "select count(*) from public.guilds k where exists (select from public.guild_members m where m.guild_id = k.id)
  and not exists (select from public.guild_members m where m.guild_id = k.id and m.role = 'leader')") $(deleted "$d") $(inv)"
  [[ $got == "dissoute 0 0 1 []" ]] || fail "suppression contre départ ($pass) : guilde, H membre, guildes sans chef, supprimé, invariants : $got"
done

# 11. Seuil d'image : chaque signalement prend la carte for no key update, puis compte ; un seul franchit le seuil à hide_image faux.
q -c "update wm.config set value = value || '{\"hide_threshold\": 5}' where key = 'image_reports'" >/dev/null
c="$(q -c "select tests.image_card('$tag i11')")"
ps=(); for i in $(seq 10); do ps+=("$(player "11p$i")"); done
hold s11 "perform from public.cards where id = '$c' for update" 10
for i in $(seq 10); do bg "11-$i" "select wm.card_image_report_set('${ps[i - 1]}', '$c', true)"; done
released s11 5
waitall
refusals . "$tmp"/11-{1..10}
quiet "$tmp"/11-{1..10}
got="$(q -c "select hide_image from public.cards where id = '$c'") $(q -c "select count(*) from wm.staff_actions where action = 'image_auto_hide'
  and target_id = '$c'") $(q -c "select count(*) from wm.card_image_reports where card_id = '$c'") $(inv)"
[[ $got == "t 1 10 []" ]] || fail "seuil d'image : hide_image, lignes image_auto_hide, signalements, invariants : $got"
q -c "update wm.config set value = '$cfg' where key = 'image_reports'" >/dev/null

# 12. Double sanction : la seconde session attend l'unicité de la clé tenue par la première, puis lit sa réponse stockée.
p="$(player 12p)"
dup="select wm.admin_sanction('$adm', '$p', 'warning', null, 'avertissement de test', null, 'k-dup')::text"
q -v VERBOSITY=verbose -c "set role service_role; begin; $dup; select pg_sleep(1); commit;" >"$tmp/12s1" 2>"$tmp/12s1.err" &
blocker=$!
sleeping "$tmp/12s1.err"
t0=$EPOCHREALTIME
got="$(q -v VERBOSITY=verbose -c "set role service_role; $dup" 2>"$tmp/12s2.err")" || fail "double sanction : seconde session en erreur" "$tmp/12s2.err"
dt="$(ms)"
wait "$blocker" || fail "double sanction : première session en erreur" "$tmp/12s1.err"
echo "21_moderation_concurrency : double sanction : seconde session servie en $dt ms" >&2
refusals . "$tmp/12s1.err" "$tmp/12s2.err"
quiet "$tmp/12s1.err" "$tmp/12s2.err"
(( dt >= 500 )) || fail "double sanction : seconde session servie en $dt ms (500 au moins)"
[[ "$(cat "$tmp/12s1")" == "$got" && $got == *'"kind": "warning"'* ]] || fail "double sanction : $got, puis $(cat "$tmp/12s1")"
got="$(q -c "select count(*) from wm.sanctions where user_id = '$p'") $(q -c "select count(*) from wm.staff_actions where action = 'sanction'
  and target_id = '$p'") $(inv)"
[[ $got == "1 1 []" ]] || fail "double sanction : sanctions, lignes d'audit, invariants : $got"

# 13. Création d'engagement contre suppression (G1) : la création tient D (lock_users) et valide avant que la suppression, qui a déjà fait son
# relevé, prenne D ; la relecture sous le verrou trouve l'engagement neuf et rend 503 BUSY sans rien écrire. Relancée, elle le dénoue.
d="$(trader 13d)"; e="$(player 13e)"
friends "$d" "$e"
x="$(card x13)"
ce="$(grant "$e" "$x")"
name="$(q -c "select username from public.profiles where id = '$d'")"
hold s13 "perform from public.profiles where id = '$d' for update" 2
first 13t "select wm.create_trade('$e', '$d', jsonb_build_array(jsonb_build_object('user_card_id', '$ce', 'offered_by', '$e')))"
bg 13d "$(del "$d")"
released s13 1
waitall
refusals 'Le site est très sollicité' "$tmp/13t" "$tmp/13d"
quiet "$tmp/13t"
is_busy "$tmp/13d" "échange contre suppression"
t="$(q -c "select id from public.trades where initiator_id = '$e' and recipient_id = '$d'")"
got="$(tstatus "$t") $(deleted "$d") $(q -c "select username = '$name' from public.profiles where id = '$d'") $(member "$d") $(inv)"
[[ $got == "pending 0 t 0 []" ]] || fail "échange contre suppression : statut, supprimé, pseudo intact, invariants : $got"
q -v VERBOSITY=verbose -c "set role service_role; $(del "$d")" >/dev/null 2>"$tmp/13d2" || fail "échange contre suppression : relance en erreur" "$tmp/13d2"
got="$(tstatus "$t") $(voided "$e" trade_voided trade "$t") $(deleted "$d") $(inv)"
[[ $got == "cancelled 1 1 []" ]] || fail "échange contre suppression, relance : statut, trade_voided de E, supprimé, invariants : $got"
# Même gabarit, la vente créée par D dans une autre session.
d="$(trader 13d2)"
x="$(card x13b)"
cd="$(grant "$d" "$x")"
hold s13b "perform from public.profiles where id = '$d' for update" 2
first 13a "select wm.create_auction('$d', '$cd', 10, 60)"
bg 13d3 "$(del "$d")"
released s13b 1
waitall
refusals 'Le site est très sollicité' "$tmp/13a" "$tmp/13d3"
quiet "$tmp/13a"
is_busy "$tmp/13d3" "vente contre suppression"
a="$(q -c "select id from public.auctions where seller_id = '$d'")"
got="$(astatus "$a") $(deleted "$d") $(inv)"
[[ $got == "active 0 []" ]] || fail "vente contre suppression : statut, supprimé, invariants : $got"
q -v VERBOSITY=verbose -c "set role service_role; $(del "$d")" >/dev/null 2>"$tmp/13d4" || fail "vente contre suppression : relance en erreur" "$tmp/13d4"
got="$(astatus "$a") $(deleted "$d") $(inv)"
[[ $got == "cancelled 1 []" ]] || fail "vente contre suppression, relance : statut, supprimé, invariants : $got"

# 14. Retrait contre suppression du vendeur : même ordre C4 (souhaits, échanges, enchères, puis profils) ; l'un attend l'échange tenu par
# l'autre sans tenir de vente. Enchères avant échanges dans le retrait : la suppression tiendrait l'échange en attendant la vente, que le
# retrait tient en attendant l'échange (40P01).
for i in $(seq 10); do
  d="$(trader "14d$i")"; e="$(player "14e$i")"; m="$(trader "14m$i" 100)"
  friends "$d" "$e"
  x="$(card "x14-$i")"
  a="$(auction "$d" "$x")"
  bid "$m" "$a" 10
  t="$(trade "$d" "$e" "$(grant "$d" "$x")")"
  hold s14 "perform from public.trades where id = '$t' for update" 2
  if (( i % 2 == 0 )); then first "14d$i" "$(del "$d")"; bg "14r$i" "$(remove "$x")"
  else first "14r$i" "$(remove "$x")"; bg "14d$i" "$(del "$d")"; fi
  released s14 1
  waitall
  refusals . "$tmp/14d$i" "$tmp/14r$i"
  quiet "$tmp/14d$i" "$tmp/14r$i"
  got="$(astatus "$a") $(tstatus "$t") $(refunds "$m" "$a") $(bal "$m") $(voided "$m" auction_voided auction "$a") \
$(voided "$e" trade_voided trade "$t") $(deleted "$d") $(q -c "select count(*) from wm.card_removals where card_id = '$x'") $(inv)"
  [[ $got == "cancelled cancelled 1 100 1 1 1 1 []" ]] || fail "retrait contre suppression, tour $i : vente, échange, refunds de M, solde de M,
    auction_voided de M, trade_voided de E, supprimé, retrait, invariants : $got"
done

# 15. Retrait contre créations (G6) : le retrait relève souhaits, échanges et ventes de X avant de prendre S (vitrine) ; les créations,
# qui attendaient S avant ce relevé, valident après lui et survivent au retrait (aucune garde neuve, G6). Aucun interblocage.
s="$(trader 15s)"; tt="$(player 15t)"
friends "$s" "$tt"
g="$(guild "$s")"
x="$(card x15)"
cv="$(grant "$s" "$x")"; ca="$(grant "$s" "$x")"; ct="$(grant "$s" "$x")"
q -c "insert into public.showcase (user_id, position, user_card_id) values ('$s', 0, '$cv')" >/dev/null
hold s15 "perform from public.profiles where id = '$s' for update" 4
first 15a "select wm.create_auction('$s', '$ca', 10, 60)" 1
first 15w "select wm.guild_wish_set('$s', '$x')" 2
first 15t "select wm.create_trade('$s', '$tt', jsonb_build_array(jsonb_build_object('user_card_id', '$ct', 'offered_by', '$s')))" 3
bg 15r "$(remove "$x")"
released s15 2
waitall
refusals . "$tmp/15a" "$tmp/15w" "$tmp/15t" "$tmp/15r"
quiet "$tmp/15a" "$tmp/15w" "$tmp/15t" "$tmp/15r"
got="$(q -c "select count(*) from public.auctions where card_id = '$x' and status = 'active'") $(open_wishes "$s") \
$(q -c "select count(*) from public.trades where status = 'pending' and id in (select trade_id from public.trade_items where card_id = '$x')") \
$(q -c "select count(*) from public.showcase where user_id = '$s'") $(q -c "select count(*) from wm.card_removals where card_id = '$x'") $(inv)"
echo "21_moderation_concurrency : retrait contre créations : ventes actives, souhaits ouverts, échanges en attente, vitrine, retrait : $got" >&2
[[ $got == "1 1 1 0 1 []" ]] || fail "retrait contre créations : ventes actives, souhaits ouverts, échanges en attente, vitrine, retrait, invariants : $got"

# 16. Suppression contre guild_wish_set du même joueur : wish_set tient son souhait ouvert (s'il en a un), puis attend D ; la suppression
# relève ses souhaits (attend le souhait tenu, puis le trouve supprimé), puis attend D ; le souhait neuf, validé avant, rend 503 BUSY.
x="$(card x16)"; y="$(card y16)"
for pass in sans avec; do
  d="$(player "16d${pass:0:1}")"; l="$(player "16l${pass:0:1}")"
  g="$(guild "$l" "$d")"
  [[ $pass == sans ]] || wish "$d" "$x" >/dev/null
  hold "s16$pass" "perform from public.profiles where id = '$d' for update" 2
  first "16w$pass" "select wm.guild_wish_set('$d', '$y')"
  bg "16d$pass" "$(del "$d")"
  released "s16$pass" 1
  waitall
  refusals 'Le site est très sollicité' "$tmp/16w$pass" "$tmp/16d$pass"
  quiet "$tmp/16w$pass"
  is_busy "$tmp/16d$pass" "suppression contre wish_set ($pass)"
  got="$(q -c "select count(*) from public.guild_wishlists where user_id = '$d' and card_id = '$y' and fulfilled_at is null") $(open_wishes "$d") \
$(deleted "$d") $(member "$d") $(inv)"
  [[ $got == "1 1 0 1 []" ]] || fail "suppression contre wish_set ($pass) : souhait neuf, souhaits ouverts, supprimé, membre, invariants : $got"
  q -v VERBOSITY=verbose -c "set role service_role; $(del "$d")" >/dev/null 2>"$tmp/16r$pass" || fail "wish_set ($pass) : relance en erreur" "$tmp/16r$pass"
  got="$(open_wishes "$d") $(member "$d") $(deleted "$d") $(inv)"
  [[ $got == "0 0 1 []" ]] || fail "suppression contre wish_set ($pass), relance : souhaits ouverts, membre, supprimé, invariants : $got"
done

# 17. Successeur tardif : la suppression relève les membres (D seul) et prend D, puis attend la guilde derrière l'adhésion de J ; J, absent
# du relevé, n'est pas tenu → 503 BUSY. Relancée, J est relevé et devient chef.
d="$(player 17d)"; j="$(player 17j)"
g="$(guild "$d")"
q -c "insert into wm.guild_invites (guild_id, user_id, inviter_id) values ('$g', '$j', '$d')" >/dev/null
hold s17 "perform from public.guilds where id = '$g' for no key update" 2
first 17j "select wm.guild_join('$j', '$g')"
bg 17d "$(del "$d")"
released s17 1
waitall
refusals 'Le site est très sollicité' "$tmp/17j" "$tmp/17d"
quiet "$tmp/17j"
is_busy "$tmp/17d" "successeur tardif"
got="$(q -c "select (leader_id = '$d') || ' ' || (select count(*) from public.guild_members where guild_id = '$g') from public.guilds where id = '$g'") \
$(deleted "$d") $(inv)"
[[ $got == "true 2 0 []" ]] || fail "successeur tardif : D chef, membres, supprimé, invariants : $got"
q -v VERBOSITY=verbose -c "set role service_role; $(del "$d")" >/dev/null 2>"$tmp/17r" || fail "successeur tardif : relance en erreur" "$tmp/17r"
got="$(q -c "select (leader_id = '$j') || ' ' || (select role from public.guild_members where user_id = '$j') from public.guilds where id = '$g'") \
$(member "$d") $(deleted "$d") $(inv)"
[[ $got == "true leader 0 1 []" ]] || fail "successeur tardif, relance : J chef, rôle de J, D membre, supprimé, invariants : $got"

# 18. Sanction contre suppression : toutes deux prennent D ; la sanction relit la pierre tombale sous le verrou (404), la suppression relit
# le bannissement actif pour l'empreinte. Jamais une empreinte sans bannissement, ni un bannissement d'une pierre tombale sans empreinte.
ban() { echo "select wm.admin_sanction('$adm', '$1', 'ban', null, 'bannissement de test')"; }
for pass in suppression bannissement; do
  d="$(player "18${pass:0:1}")"
  hold "s18$pass" "perform from public.profiles where id = '$d' for update" 2
  if [[ $pass == suppression ]]; then first "18d$pass" "$(del "$d")"; bg "18s$pass" "$(ban "$d")"
  else first "18s$pass" "$(ban "$d")"; bg "18d$pass" "$(del "$d")"; fi
  released "s18$pass" 1
  waitall
  refusals 'Joueur introuvable' "$tmp/18d$pass" "$tmp/18s$pass"
  quiet "$tmp/18d$pass"
  got="$(grep -c '^ERROR:  P0001: Joueur introuvable$' "$tmp/18s$pass") $(q -c "select count(*) from wm.sanctions where user_id = '$d' and kind = 'ban'") \
$(q -c "select count(*) from wm.banned_emails b join auth.users u on u.id = b.user_id where b.user_id = '$d' and b.email_hash = wm.email_hash(u.email)") \
$(q -c "select count(*) from wm.staff_actions where action = 'sanction' and target_id = '$d'") $(deleted "$d") $(inv)"
  if [[ $pass == suppression ]]; then want="1 0 0 0 1 []"; else want="0 1 1 1 1 []"; fi
  [[ $got == "$want" ]] || fail "sanction contre suppression ($pass) : refus, bannissements, empreintes, audit, supprimé, invariants : $got ($want attendu)"
done

# 19. Retrait d'ami contre suppression : friend_remove tient l'amitié, puis annule l'échange de la paire. La suppression prend les amitiés
# avant ses échanges : elle attend derrière friend_remove sans tenir l'échange, puis relit l'amitié supprimée et l'échange annulé. Échanges
# avant amitiés, elle tiendrait l'échange en attendant l'amitié, que friend_remove tient en attendant l'échange (40P01).
a1="$(player 19a)"; b1="$(player 19b)"
friends "$a1" "$b1"
x="$(card x19)"
t="$(trade "$a1" "$b1" "$(grant "$a1" "$x")")"
fr="$(q -c "select id from public.friendships where requester_id = '$a1' and addressee_id = '$b1'")"
hold s19 "perform from public.friendships where id = '$fr' for update" 2
first 19f "select wm.friend_remove('$b1', '$fr')"
bg 19d "$(del "$a1")"
released s19 2
waitall
refusals . "$tmp/19f" "$tmp/19d"
quiet "$tmp/19f" "$tmp/19d"
got="$(tstatus "$t") $(q -c "select count(*) from public.friendships where id = '$fr'") $(owns "$a1" "$x") $(deleted "$a1") $(inv)"
[[ $got == "cancelled 0 0 1 []" ]] || fail "retrait d'ami contre suppression : échange, amitié, copie de A, supprimé, invariants : $got"

# 20. Requêtes en vol : wm.actor laisse passer D (la suppression n'a pas validé), puis chaque appel attend le profil de D ; après le commit,
# wm.lock_user et wm.lock_users relisent deleted_accounts pour l'acteur et refusent (401), rien n'est écrit pour la pierre tombale.
d="$(trader 20d 100)"; s2="$(trader 20s)"; m="$(trader 20m 100)"
x="$(card x20)"
a="$(auction "$s2" "$x")"
bid "$m" "$a" 10
q -c "update public.profiles set packs_remaining = 5 where id = '$d'" >/dev/null
held 20h "$(del "$d")" 2
first 20p "select wm.open_pack('$d', 'Europe/Paris')" 1
first 20b "select wm.place_bid('$d', '$a', 20)" 2
first 20g "select wm.guild_create('$d', '${tag}g20')" 3
wait "$blocker" || fail "requêtes en vol : suppression en erreur" "$tmp/20h"
waitall
refusals 'Session expirée' "$tmp/20p" "$tmp/20b" "$tmp/20g"
quiet "$tmp/20h"
got="$(cat "$tmp/20p" "$tmp/20b" "$tmp/20g" | grep -c '^ERROR:  P0001: Session expirée, reconnecte-toi\.$') \
$(cat "$tmp/20p" "$tmp/20b" "$tmp/20g" | grep -c '"status": 401') $(q -c "select count(*) from public.user_cards where user_id = '$d'") \
$(q -c "select current_bidder_id = '$m' from public.auctions where id = '$a'") $(bal "$m") $(bal "$d") \
$(q -c "select count(*) from public.guild_members where user_id = '$d'") $(deleted "$d") $(inv)"
[[ $got == "3 3 0 t 90 100 0 1 []" ]] || fail "requêtes en vol : refus 401, codes, copies de D, M meneur, soldes de M et D, guilde, supprimé, invariants : $got"
