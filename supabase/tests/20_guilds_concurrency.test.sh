#!/usr/bin/env bash
# Guildes et succès en parallèle (joueurs, cartes et guildes du tag supprimés à la sortie, config guild et chat_burst restaurées). Derrière
# un bloqueur, l'attente est prouvée : il tient ses verrous jusqu'à n appels en attente, 1 s au plus après le premier vu (5 s en tout), et
# le nombre maximal vu doit atteindre la moitié de n. « La fin » : bataille de A (gagnant, membre de G) contre B, à la dernière réponse d'un
# KO, défenseur B ; elle prend la bataille, les deux profils, puis la guilde de A en key share (wm.guild_score_add). « D'abord » : l'appel
# est lancé, puis attendu en attente d'un verrou (waiting, C2) avant le suivant. Chaque scénario finit par check_invariants() = [].
# 1. join contre la fin : B invité dans G ; B tenu, la fin d'abord, puis guild_join(B, G) → servis, B membre, G à +500.
# 2. invite contre la fin : M (membre de G, ami de B) invite B ; B tenu, la fin d'abord → servis, invitation posée, G à +500.
# 3. transfer contre la fin : le chef L transfère à A ; A tenu, la fin d'abord → servis, A chef, G à +500.
# 4. create contre la fin : B crée une guilde ; B tenu, la fin d'abord → servis, B chef de la sienne, G à +500.
# 5. leave contre la fin (M4), A < B : B tenu, la fin d'abord (elle tient A), puis A quitte G (chef L), puis A seul dissout la sienne →
#    servis ; guildPoints 0 ou 500, autant au score de G ; après la dissolution, aucune ligne de score de la guilde.
# 6. kick contre la fin et contre invite : A tenu, la fin d'abord, puis le chef exclut A → servis, A exclu, G à +500 ; puis M < C, C tenu,
#    invite(M, C) d'abord (M tenu par lui), puis le chef exclut M → servis, C invité, M exclu et notifié.
# 7. Dons croisés (M15), 20 tours, donations_per_day à 100 : A souhaite X, B souhaite Y, A et B tenus, guild_donate(A, W_B) et
#    guild_donate(B, W_A) → servis ; puis 5 duels de deux donneurs (C et A) sur le souhait de B, B tenu → un don, un 404 « Ce souhait
#    n'existe plus » ; une ligne guild_donations par souhait clos, aucune sur un souhait ouvert.
# 8. La fin pendant un lot de règlement (M15) : vente due d'un vendeur de G, lot tenu 1 s après son règlement, puis la fin → servie entre
#    0,5 et 2 s ; G à score_battles 500 et score_wb = le prix.
# 9. Double claim (D:1084, M15) : 10 achievements_claim(A, X) sans clé, A tenu → un {"ok": true}, 9 refus « Ce succès a déjà été
#    réclamé », une ligne ach:<X>, solde + la récompense. Puis même clé, deux sessions : la seconde servie après 0,5 s, au même corps.
# 10. Adhésions au plafond : max_members à 3, G à 2 membres, 5 invités, G tenue (no key update) → 1 adhésion, 4 refus « Cette guilde est
#     pleine », 3 membres.
# 11. Deux check simultanés, A tenu → un {"ok": true, …}, un 429.
# 12. kick contre un don (G3) : W_B tenu, guild_donate(A, W_B) d'abord, puis le chef exclut B → servis dans cet ordre, aucun souhait
#     ouvert de B.
# 13. kick contre guild_wish_set de l'exclu : W_B tenu, guild_wish_set(B, Y) d'abord, puis le chef exclut B → servis, aucun souhait ouvert
#     de B.
# 14. leave contre guild_wish_set du même joueur : W_B tenu, guild_wish_set(B, Y) d'abord, puis B quitte G → servis, aucun souhait ouvert
#     de B ; puis A seul, même gabarit → sa guilde dissoute, aucun souhait ouvert de A.
# 15. Départ ou exclusion en vol (transaction tenue 1 s après l'appel), contre un souhait, un don, un message ou la fin :
#     a. leave(B), B sans souhait, puis guild_wish_set(B, Y) → servi sans attendre : souhait orphelin (course acceptée de G3), invisible
#        dans guild_home et refusé au don en 404 « Ce souhait n'existe plus » (G18) ;
#     b. leave(C), C avec W_C, puis guild_donate(A, W_C) et guild_wish_set(C, X) → servis après le départ : 404 « Ce souhait n'existe
#        plus » et 404 « Tu n'es dans aucune guilde », aucun souhait ouvert de C ;
#     c. kick(D), puis guild_wish_set(D, Y) et guild_chat_send(D) → 404 « Tu n'es dans aucune guilde » chacun, ni souhait ni message ;
#     d. leave(E), puis la fin de E et guild_chat_send(E) → servis sans attendre : G à +500, le message dans G (limite acceptée de C4 :
#        lecture de guild_members sans verrou) ;
#     e. kick(H), puis la fin de H → servie après l'exclusion : guildPoints 0, score de G inchangé.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="gld_$RANDOM$RANDOM"
keys="'guild', 'chat_burst'"
cfg="$(q -c "select jsonb_object_agg(key, value) from wm.config where key in ($keys)")"
cleanup() {
  wait  # appels encore en vol après un échec : rien n'est supprimé sous eux
  # Clés NO ACTION vers public.cards : le pool d'abord (1200_wm_packs.sql:25), puis les guildes du tag (une guilde survit à ses membres,
  # et ses dons retiennent les profils), puis les joueurs, leurs copies et leurs batailles avec eux, puis les cartes, leurs banques et leur
  # file avec elles. Les clés d'idempotence n'ont pas de clé étrangère vers les profils.
  q -c "select wm.pool_remove(id) from public.cards where wikipedia_title like '$tag %'" \
    -c "delete from public.guilds where id in (select guild_id from public.guild_members m join public.profiles p on p.id = m.user_id
      where p.username like '${tag}_%') or leader_id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from wm.idempotency_keys where user_id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from auth.users where id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" \
    -c "update wm.config set value = '$cfg'::jsonb -> key where key in ($keys)" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "$1" >&2; shift; (( $# == 0 )) || cat "$@" >&2; exit 1; }  # $2… : sorties d'erreur à montrer

player() { q -c "select tests.make_user('${tag}_$1')"; }
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
  echo "20_guilds_concurrency : $1 : $max appels au plus en attente derrière le bloqueur" >&2
  (( max >= $2 )) || fail "$1 : contention insuffisante, $max appels en attente ($2 au moins)"
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
# Lance $2 par bg (fichier $1), puis attend qu'il attende un verrou avant de rendre la main (C2).
first() {
  bg "$1" "$2"
  local p="${pids[-1]}"
  until (( $(waiting) >= 1 )); do
    kill -0 "$p" 2>/dev/null || fail "$1 jamais en attente d'un verrou" "$tmp/$1"
    sleep 0.05
  done
}
# Transaction tenue 1 s après $2 (fichier d'erreurs $1) ; rendu à son PgSleep.
held() {
  q -v VERBOSITY=verbose -c "begin; $2; select pg_sleep(1); commit;" >/dev/null 2>"$tmp/$1" &
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
gconf() { q -c "update wm.config set value = ('$cfg'::jsonb -> 'guild') || '$1' where key = 'guild'" >/dev/null; }
copy() { q -c "select id from public.user_cards where user_id = '$1' and card_id = '$2' order by id limit 1"; }
wish() { q -c "select wm.guild_wish_set('$1', '$2') #>> '{wishlist,id}'"; }
open_wishes() { q -c "select count(*) from public.guild_wishlists where user_id = '$1' and fulfilled_at is null"; }
member() { q -c "select count(*) from public.guild_members where user_id = '$1'"; }
gp() { q -c "select game_state ->> 'guildPoints' from public.battles where id = '$1'"; }
score() { q -c "select coalesce((select score_battles || ' ' || score_wb from public.guild_weekly_scores where guild_id = '$1'
  and week_start = wm.week_start(now())), 'aucun')"; }
inv() { q -c "select wm.check_invariants()"; }
# Deux joueurs, « petit grand » dans l'ordre des id.
pair() { local x y; x="$(player "$1")"; y="$(player "$2")"; q -c "select least('$x'::uuid, '$y') || ' ' || greatest('$x'::uuid, '$y')"; }

# 1. join contre la fin : B, seul profil commun, tenu ; la fin le demande la première (C2), le join ensuite. La guilde prise avant le
# profil, le join la tiendrait en attendant B, que la fin tient en attendant la guilde (40P01).
a="$(player 1a)"; b="$(player 1b)"; l="$(player 1l)"
g="$(guild "$l" "$a")"
q -c "insert into wm.guild_invites (guild_id, user_id, inviter_id) values ('$g', '$b', '$l')" >/dev/null
end_of "$a" "$b"
hold s1 "perform from public.profiles where id = '$b' for update" 2
first 1e "$fin"
bg 1j "select wm.guild_join('$b', '$g')"
released s1 1
waitall
refusals . "$tmp/1e" "$tmp/1j"
quiet "$tmp/1e" "$tmp/1j"
got="$(member "$b") $(gp "$bt") $(score "$g") $(inv)"
[[ $got == "1 500 500 0 []" ]] || fail "join contre la fin : B membre, guildPoints, score de G, invariants : $got"

# 2. invite contre la fin : M invite B (lock_users, puis la guilde) pendant que la fin tient A et demande B.
a="$(player 2a)"; b="$(player 2b)"; l="$(player 2l)"; m="$(player 2m)"
g="$(guild "$l" "$a" "$m")"
q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$m', '$b', 'accepted')" >/dev/null
end_of "$a" "$b"
hold s2 "perform from public.profiles where id = '$b' for update" 2
first 2e "$fin"
bg 2i "select wm.guild_invite('$m', '$b')"
released s2 1
waitall
refusals . "$tmp/2e" "$tmp/2i"
quiet "$tmp/2e" "$tmp/2i"
got="$(q -c "select count(*) from wm.guild_invites where guild_id = '$g' and user_id = '$b' and inviter_id = '$m'") $(gp "$bt") $(score "$g") $(inv)"
[[ $got == "1 500 500 0 []" ]] || fail "invite contre la fin : invitation, guildPoints, score de G, invariants : $got"

# 3. transfer contre la fin : le chef transfère à A, tenu ; la fin le demande la première.
a="$(player 3a)"; b="$(player 3b)"; l="$(player 3l)"
g="$(guild "$l" "$a")"
end_of "$a" "$b"
hold s3 "perform from public.profiles where id = '$a' for update" 2
first 3e "$fin"
bg 3t "select wm.guild_transfer('$l', '$a')"
released s3 1
waitall
refusals . "$tmp/3e" "$tmp/3t"
quiet "$tmp/3e" "$tmp/3t"
got="$(q -c "select (leader_id = '$a') || ' ' || (select role from public.guild_members where user_id = '$a') from public.guilds where id = '$g'") \
$(gp "$bt") $(score "$g") $(inv)"
[[ $got == "true leader 500 500 0 []" ]] || fail "transfer contre la fin : A chef, rôle de A, guildPoints, score de G, invariants : $got"

# 4. create contre la fin : B crée une guilde pendant que la fin le demande.
a="$(player 4a)"; b="$(player 4b)"; l="$(player 4l)"
g="$(guild "$l" "$a")"
end_of "$a" "$b"
hold s4 "perform from public.profiles where id = '$b' for update" 2
first 4e "$fin"
bg 4c "select wm.guild_create('$b', '$tag 4')"
released s4 1
waitall
refusals . "$tmp/4e" "$tmp/4c"
quiet "$tmp/4e" "$tmp/4c"
got="$(q -c "select count(*) from public.guilds where leader_id = '$b'") $(gp "$bt") $(score "$g") $(inv)"
[[ $got == "1 500 500 0 []" ]] || fail "create contre la fin : guilde de B, guildPoints, score de G, invariants : $got"

# 5. leave contre la fin (M4) : A < B, B tenu ; la fin tient la bataille et A en attendant B. leave ne prend aucun profil et la guilde en
# no key update (for update pour la dissoudre, mais sans profil) : jamais un cycle. Guilde puis profil de A, ce serait le cycle de M4.
for pass in membre dissolution; do
  read -r a b <<<"$(pair "5a${pass:0:1}" "5b${pass:0:1}")"
  if [[ $pass == membre ]]; then l="$(player 5l)"; g="$(guild "$l" "$a")"; else g="$(guild "$a")"; fi
  end_of "$a" "$b"
  hold "s5$pass" "perform from public.profiles where id = '$b' for update" 2
  first "5e$pass" "$fin"
  bg "5l$pass" "select wm.guild_leave('$a')"
  released "s5$pass" 1
  waitall
  refusals . "$tmp/5e$pass" "$tmp/5l$pass"
  quiet "$tmp/5e$pass" "$tmp/5l$pass"
  p="$(gp "$bt")"; s="$(score "$g")"
  [[ $p == 0 || $p == 500 ]] || fail "leave contre la fin ($pass) : guildPoints $p"
  if [[ $pass == membre ]]; then
    [[ $p == 0 && $s == aucun || $s == "$p 0" ]] || fail "leave contre la fin : guildPoints $p, score de G $s"
  fi
  got="$(member "$a") $(q -c "select count(*) from public.guilds where id = '$g'") $(q -c "select count(*) from public.guild_weekly_scores
    where guild_id = '$g'") $(inv)"
  if [[ $pass == membre ]]; then want="0 1 $(( p / 500 )) []"; else want="0 0 0 []"; fi
  [[ $got == "$want" ]] || fail "leave contre la fin ($pass) : A membre, guilde, lignes de score, invariants : $got ($want attendu)"
done

# 6. kick contre la fin : la fin tient A, kick le demande en key share (G2) sans rien tenir encore. Puis kick contre invite : M < C, C
# tenu ; invite tient M et demande C ; kick demande M en key share avant la guilde. Sans ce verrou, kick tiendrait la guilde, puis
# attendrait M à l'insertion de guild_kicked, que invite tient en attendant la guilde (40P01).
a="$(player 6a)"; b="$(player 6b)"; l="$(player 6l)"
g="$(guild "$l" "$a")"
end_of "$a" "$b"
hold s6 "perform from public.profiles where id = '$a' for update" 2
first 6e "$fin"
bg 6k "select wm.guild_kick('$l', '$a')"
released s6 1
waitall
refusals . "$tmp/6e" "$tmp/6k"
quiet "$tmp/6e" "$tmp/6k"
got="$(member "$a") $(gp "$bt") $(score "$g") $(inv)"
[[ $got == "0 500 500 0 []" ]] || fail "kick contre la fin : A membre, guildPoints, score de G, invariants : $got"
read -r m c <<<"$(pair 6m 6c)"
l="$(player 6l2)"
g="$(guild "$l" "$m")"
q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$m', '$c', 'accepted')" >/dev/null
hold s6b "perform from public.profiles where id = '$c' for update" 2
first 6i "select wm.guild_invite('$m', '$c')"
bg 6k2 "select wm.guild_kick('$l', '$m')"
released s6b 1
waitall
refusals . "$tmp/6i" "$tmp/6k2"
quiet "$tmp/6i" "$tmp/6k2"
got="$(member "$m") $(q -c "select count(*) from wm.guild_invites where guild_id = '$g' and user_id = '$c'") $(q -c "select count(*)
  from public.notifications where user_id = '$m' and type = 'guild_kicked'") $(inv)"
[[ $got == "0 1 1 []" ]] || fail "kick contre invite : M membre, invitation de C, guild_kicked, invariants : $got"

# 7. Dons croisés : chaque don prend son souhait, puis les deux profils dans l'ordre des id ; deux souhaits distincts, jamais un cycle. Deux
# donneurs sur un souhait : le second l'attend, puis le relit clos (404).
gconf '{"donations_per_day": 100}'
a="$(player 7a)"; b="$(player 7b)"; c="$(player 7c)"; l="$(player 7l)"
g="$(guild "$l" "$a" "$b" "$c")"
cx="$(card x7)"; cy="$(card y7)"
q -c "select wm.grant_copy('$a', '$cy', false) from generate_series(1, 25)" -c "select wm.grant_copy('$b', '$cx', false) from generate_series(1, 20)" \
  -c "select wm.grant_copy('$c', '$cy', false) from generate_series(1, 5)" >/dev/null
for i in $(seq 20); do
  wa="$(wish "$a" "$cx")"; wb="$(wish "$b" "$cy")"
  hold s7 "perform from public.profiles where id in ('$a', '$b') order by id for update" 2
  bg "7a$i" "select wm.guild_donate('$a', '$wb', '$(copy "$a" "$cy")')"
  bg "7b$i" "select wm.guild_donate('$b', '$wa', '$(copy "$b" "$cx")')"
  released s7 1
  waitall
  refusals . "$tmp/7a$i" "$tmp/7b$i"
  quiet "$tmp/7a$i" "$tmp/7b$i"
  got="$(q -c "select count(*) from public.guild_donations where wishlist_id in ('$wa', '$wb')") $(inv)"
  [[ $got == "2 []" ]] || fail "dons croisés, tour $i : dons, invariants : $got"
done
for i in $(seq 5); do
  wb="$(wish "$b" "$cy")"
  hold s7d "perform from public.profiles where id = '$b' for update" 2
  bg "7c$i" "select wm.guild_donate('$c', '$wb', '$(copy "$c" "$cy")')"
  bg "7d$i" "select wm.guild_donate('$a', '$wb', '$(copy "$a" "$cy")')"
  released s7d 1
  waitall
  refusals "Ce souhait n'existe plus" "$tmp/7c$i" "$tmp/7d$i"
  got="$(cat "$tmp/7c$i" "$tmp/7d$i" | grep -c "^ERROR:  P0001: Ce souhait n'existe plus$") $(q -c "select count(*) from public.guild_donations
    where wishlist_id = '$wb'") $(inv)"
  [[ $got == "1 1 []" ]] || fail "deux donneurs, tour $i : refus, dons, invariants : $got"
done
got="$(q -c "select count(*) filter (where w.fulfilled_at is not null) || ' ' || count(*) filter (where (w.fulfilled_at is not null)
  <> (select count(*) = 1 from public.guild_donations d where d.wishlist_id = w.id)) from public.guild_wishlists w where w.guild_id = '$g'")"
[[ $got == "45 0" ]] || fail "dons : souhaits clos, souhaits sans exactement un don par souhait clos : $got"
gconf '{}'

# 8. La fin pendant un lot de règlement : le lot tient la ligne de score de G (upsert) jusqu'à son commit ; la fin l'attend, sans cycle.
a="$(player 8a)"; b="$(player 8b)"; s="$(player 8s)"; t="$(q -c "select tests.make_user('${tag}_8t', 1000)")"
g="$(guild "$s" "$a")"
cs="$(card s8)"
q -c "select wm.set_human_verified(u) from unnest(array['$s', '$t']::uuid[]) u" >/dev/null
x="$(q -c "select wm.create_auction('$s', (wm.grant_copy('$s', '$cs', false)).id, 10, 60) ->> 'auction_id'")"
q -c "select wm.place_bid('$t', '$x', 10)" -c "update public.auctions set end_at = now() - interval '1 second' where id = '$x'" >/dev/null
end_of "$a" "$b"
q -v VERBOSITY=verbose -c "begin; select wm.settle_due_auctions(500); select pg_sleep(1); commit;" >/dev/null 2>"$tmp/8s" &
blocker=$!
sleeping "$tmp/8s"
t0=$EPOCHREALTIME
q -v VERBOSITY=verbose -c "set role service_role; $fin" >/dev/null 2>"$tmp/8e" || fail "fin pendant un lot : fin en erreur" "$tmp/8e"
d="$(ms)"
wait "$blocker" || fail "fin pendant un lot : lot en erreur" "$tmp/8s"
echo "20_guilds_concurrency : fin pendant un lot : servie en $d ms" >&2
quiet "$tmp/8s" "$tmp/8e"
(( d >= 500 && d <= 2000 )) || fail "fin pendant un lot : servie en $d ms (0,5 à 2 s)"
got="$(q -c "select status from public.auctions where id = '$x'") $(gp "$bt") $(score "$g") $(inv)"
[[ $got == "settled_sold 500 500 10 []" ]] || fail "fin pendant un lot : vente, guildPoints, score de G, invariants : $got"

# 9. Double claim : la garde claimed_at est relue sous le profil ; lue avant, les dix passeraient (le rejeu de wallet_apply masque le
# crédit, D-C16). Puis même clé : la seconde session attend l'unicité de la clé tenue par la première, puis lit sa réponse stockée.
a="$(player 9a)"
read -r x x2 r <<<"$(q -c "select (array_agg(id order by sort_order))[1] || ' ' || (array_agg(id order by sort_order))[2] || ' '
  || (array_agg(wikibidous_reward order by sort_order))[1] from public.achievements")"
q -c "insert into public.user_achievements (user_id, achievement_id) values ('$a', '$x'), ('$a', '$x2')" >/dev/null
hold s9 "perform from public.profiles where id = '$a' for update" 10
for k in $(seq 10); do
  q -v VERBOSITY=verbose -c "set role service_role; select wm.achievements_claim('$a', '$x')" >"$tmp/9-$k.out" 2>"$tmp/9-$k" & pids+=($!)
done
released s9 5
waitall
refusals 'Ce succès a déjà été réclamé' "$tmp"/9-{1..10}
got="$(cat "$tmp"/9-{1..10}.out | grep -c '^{"ok": true}$') $(cat "$tmp"/9-{1..10} | grep -c '^ERROR:  P0001: Ce succès a déjà été réclamé$') \
$(q -c "select count(*) from wm.wb_ledger where user_id = '$a' and reason = 'achievement' and ref = 'ach:$x'") $(q -c "select wikibidous_balance from public.profiles
  where id = '$a'") $(inv)"
[[ $got == "1 9 1 $r []" ]] || fail "double claim : succès, refus, lignes ach:<X>, solde, invariants : $got (1 9 1 $r [] attendu)"
dup="select wm.achievements_claim('$a', '$x2', 'k-dup')::text"
q -v VERBOSITY=verbose -c "set role service_role; begin; $dup; select pg_sleep(1); commit;" >"$tmp/9s1" 2>"$tmp/9s1.err" &
blocker=$!
sleeping "$tmp/9s1.err"
t0=$EPOCHREALTIME
got="$(q -v VERBOSITY=verbose -c "set role service_role; $dup" 2>"$tmp/9s2.err")" || fail "même clé : seconde session en erreur" "$tmp/9s2.err"
d="$(ms)"
wait "$blocker" || fail "même clé : première session en erreur" "$tmp/9s1.err"
echo "20_guilds_concurrency : même clé : seconde session servie en $d ms" >&2
quiet "$tmp/9s1.err" "$tmp/9s2.err"
(( d >= 500 )) || fail "même clé : seconde session servie en $d ms (500 au moins)"
[[ "$(cat "$tmp/9s1")" == "$got" && $got == '{"ok": true}' ]] || fail "même clé : $got, puis $(cat "$tmp/9s1")"
got="$(q -c "select count(*) from wm.wb_ledger where user_id = '$a' and reason = 'achievement' and ref = 'ach:$x2'") $(inv)"
[[ $got == "1 []" ]] || fail "même clé : lignes ach:<X2>, invariants : $got"

# 10. Adhésions au plafond : chaque join compte les membres sous la guilde (no key update), donc après l'adhésion qui la tenait.
gconf '{"max_members": 3}'
l="$(player 10l)"; m="$(player 10m)"
g="$(guild "$l" "$m")"
ps=(); for i in $(seq 5); do ps+=("$(player "10p$i")"); done
q -c "insert into wm.guild_invites (guild_id, user_id, inviter_id) select '$g', unnest(array['$(IFS=,; echo "${ps[*]}" | sed "s/,/','/g")']::uuid[]), '$l'" >/dev/null
hold s10 "perform from public.guilds where id = '$g' for no key update" 5
for i in $(seq 5); do bg "10-$i" "select wm.guild_join('${ps[i - 1]}', '$g')"; done
waitall  # les comptes avant la contention : une guilde lue sans verrou se montre par ses membres en trop
refusals 'Cette guilde est pleine' "$tmp"/10-{1..5}
got="$(cat "$tmp"/10-{1..5} | grep -c '^ERROR:  P0001: Cette guilde est pleine$') $(q -c "select count(*) from public.guild_members where guild_id = '$g'") $(inv)"
[[ $got == "4 3 []" ]] || fail "adhésions au plafond : refus, membres, invariants : $got"
released s10 2
gconf '{}'

# 11. Deux check simultanés : le second relit achievements_checked_at sous le profil, posé par le premier.
a="$(player 11a)"
hold s11 "perform from public.profiles where id = '$a' for update" 2
for k in 1 2; do
  q -v VERBOSITY=verbose -c "set role service_role; select wm.achievements_check('$a')" >"$tmp/11-$k.out" 2>"$tmp/11-$k" & pids+=($!)
done
released s11 1
waitall
refusals 'Le site demande de ralentir' "$tmp/11-1" "$tmp/11-2"
got="$(cat "$tmp/11-1.out" "$tmp/11-2.out" | grep -c '"ok": true') $(cat "$tmp/11-1" "$tmp/11-2" | grep -c '"status": 429') $(inv)"
[[ $got == "1 1 []" ]] || fail "check doublé : succès, refus 429, invariants : $got"

# 12. kick contre un don : le souhait d'abord, partout (G3). Le don tient W_B, puis demande B en exclusif ; kick attend W_B sans rien tenir.
# Souhait pris après la guilde, kick tiendrait B en key share en attendant W_B, que le don tient en attendant B (40P01).
a="$(player 12a)"; b="$(player 12b)"; l="$(player 12l)"
g="$(guild "$l" "$a" "$b")"
cy="$(card y12)"
q -c "select wm.grant_copy('$a', '$cy', false)" >/dev/null
wb="$(wish "$b" "$cy")"
hold s12 "perform from public.guild_wishlists where id = '$wb' for update" 2
first 12d "select wm.guild_donate('$a', '$wb', '$(copy "$a" "$cy")')"
bg 12k "select wm.guild_kick('$l', '$b')"
released s12 1
waitall
refusals . "$tmp/12d" "$tmp/12k"
quiet "$tmp/12d" "$tmp/12k"
got="$(q -c "select count(*) from public.guild_donations where wishlist_id = '$wb'") $(member "$b") $(open_wishes "$b") $(inv)"
[[ $got == "1 0 0 []" ]] || fail "kick contre un don : don, B membre, souhaits ouverts de B, invariants : $got"

# 13. kick contre guild_wish_set de l'exclu : même gabarit ; wish_set tient W_B, puis demande B en exclusif ; le kick qui suit efface le
# souhait remplacé (nouvelle instruction, nouvel instantané).
a="$(player 13a)"; b="$(player 13b)"; l="$(player 13l)"
g="$(guild "$l" "$a" "$b")"
cx="$(card x13)"; cy="$(card y13)"
wb="$(wish "$b" "$cx")"
hold s13 "perform from public.guild_wishlists where id = '$wb' for update" 2
first 13w "select wm.guild_wish_set('$b', '$cy')"
bg 13k "select wm.guild_kick('$l', '$b')"
released s13 1
waitall
refusals . "$tmp/13w" "$tmp/13k"
quiet "$tmp/13w" "$tmp/13k"
got="$(member "$b") $(open_wishes "$b") $(inv)"
[[ $got == "0 0 []" ]] || fail "kick contre wish_set : B membre, souhaits ouverts de B, invariants : $got"

# 14. leave contre guild_wish_set du même joueur : leave prend le souhait ouvert d'abord (G3), donc attend le remplacement, puis l'efface ou
# le dissout. Sans ce verrou, le départ simple effacerait un souhait déjà remplacé (orphelin), et la dissolution tiendrait la guilde en
# attendant W_A (cascade), que wish_set tient en attendant la guilde (40P01).
cx="$(card x14)"; cy="$(card y14)"
for pass in membre dissolution; do
  u="$(player "14u${pass:0:1}")"
  if [[ $pass == membre ]]; then l="$(player 14l)"; g="$(guild "$l" "$u")"; else g="$(guild "$u")"; fi
  w="$(wish "$u" "$cx")"
  hold "s14$pass" "perform from public.guild_wishlists where id = '$w' for update" 2
  first "14w$pass" "select wm.guild_wish_set('$u', '$cy')"
  bg "14l$pass" "select wm.guild_leave('$u')"
  released "s14$pass" 1
  waitall
  refusals . "$tmp/14w$pass" "$tmp/14l$pass"
  quiet "$tmp/14w$pass" "$tmp/14l$pass"
  got="$(member "$u") $(open_wishes "$u") $(q -c "select count(*) from public.guilds where id = '$g'") $(inv)"
  if [[ $pass == membre ]]; then want="0 0 1 []"; else want="0 0 0 []"; fi
  [[ $got == "$want" ]] || fail "leave contre wish_set ($pass) : membre, souhaits ouverts, guilde, invariants : $got ($want attendu)"
done

# 15. Départ ou exclusion en vol. leave ne prend aucun profil (M5b-1) et la guilde en no key update, compatible avec le key share de
# wish_set, chat_send et guild_score_add : un appel lancé pendant le départ, sans souhait ouvert à attendre, lit encore l'appartenance et
# passe (limite acceptée, C4 et G3), et G18 rend le souhait ainsi laissé invisible et refusé au don. kick prend l'exclu en key share
# (G2) : tout appel qui prend son profil l'attend, puis relit l'appartenance.
a="$(player 15a)"; b="$(player 15b)"; c="$(player 15c)"; dd="$(player 15d)"; e="$(player 15e)"; h="$(player 15h)"; l="$(player 15l)"
g="$(guild "$l" "$a" "$b" "$c" "$dd" "$e" "$h")"
cx="$(card x15)"; cy="$(card y15)"
q -c "select wm.grant_copy('$a', '$cy', false) from generate_series(1, 2)" >/dev/null
# a. leave(B), puis wish_set(B) : servi sans attendre, souhait orphelin.
held 15al "select wm.guild_leave('$b')"
t0=$EPOCHREALTIME
w="$(q -v VERBOSITY=verbose -c "set role service_role; select wm.guild_wish_set('$b', '$cy') #>> '{wishlist,id}'" 2>"$tmp/15aw")" \
  || fail "départ en vol : wish_set en erreur" "$tmp/15aw"
d="$(ms)"
wait "$blocker" || fail "départ en vol : leave en erreur" "$tmp/15al"
echo "20_guilds_concurrency : départ en vol : wish_set servi en $d ms" >&2
quiet "$tmp/15al" "$tmp/15aw"
(( d < 500 )) || fail "départ en vol : wish_set servi en $d ms (moins de 500)"
q -v VERBOSITY=verbose -c "set role service_role; select wm.guild_donate('$a', '$w', '$(copy "$a" "$cy")')" >/dev/null 2>"$tmp/15ad" || true
got="$(member "$b") $(open_wishes "$b") $(q -c "select wm.guild_home('$l') -> 'wishlists' @> '[{\"id\": \"$w\"}]'") \
$(grep -c "^ERROR:  P0001: Ce souhait n'existe plus$" "$tmp/15ad") $(inv)"
[[ $got == "0 1 f 1 []" ]] || fail "départ en vol : B membre, souhaits ouverts de B, souhait visible, refus du don, invariants : $got"
# b. leave(C), C avec W_C, puis un don à W_C et wish_set(C) : tous deux attendent W_C, puis le relisent effacé.
wc="$(wish "$c" "$cy")"
held 15bl "select wm.guild_leave('$c')"
bg 15bd "select wm.guild_donate('$a', '$wc', '$(copy "$a" "$cy")')"
bg 15bw "select wm.guild_wish_set('$c', '$cx')"
wait "$blocker" || fail "départ en vol : leave en erreur" "$tmp/15bl"
waitall
quiet "$tmp/15bl"
refusals "Ce souhait n'existe plus" "$tmp/15bd"
refusals "Tu n'es dans aucune guilde" "$tmp/15bw"
got="$(grep -c "^ERROR:  P0001: Ce souhait n'existe plus$" "$tmp/15bd") $(grep -c "^ERROR:  P0001: Tu n'es dans aucune guilde$" "$tmp/15bw") \
$(member "$c") $(open_wishes "$c") $(inv)"
[[ $got == "1 1 0 0 []" ]] || fail "départ en vol, souhait ouvert : refus du don, refus de wish_set, C membre, souhaits ouverts, invariants : $got"
# c. kick(D), puis wish_set(D) et chat_send(D) : tous deux attendent D, puis relisent l'appartenance.
held 15ck "select wm.guild_kick('$l', '$dd')"
bg 15cw "select wm.guild_wish_set('$dd', '$cy')"
bg 15cc "select wm.guild_chat_send('$dd', 'bonjour')"
wait "$blocker" || fail "exclusion en vol : kick en erreur" "$tmp/15ck"
waitall
quiet "$tmp/15ck"
refusals "Tu n'es dans aucune guilde" "$tmp/15cw" "$tmp/15cc"
got="$(cat "$tmp/15cw" "$tmp/15cc" | grep -c "^ERROR:  P0001: Tu n'es dans aucune guilde$") $(open_wishes "$dd") $(q -c "select count(*)
  from public.guild_chat_messages where user_id = '$dd'") $(inv)"
[[ $got == "2 0 0 []" ]] || fail "exclusion en vol : refus, souhaits ouverts de D, messages de D, invariants : $got"
# d. leave(E), puis la fin de E et chat_send(E) : servis sans attendre, la guilde quittée créditée.
f="$(player 15f)"
end_of "$e" "$f"
held 15dl "select wm.guild_leave('$e')"
bg 15de "$fin"
bg 15dc "select wm.guild_chat_send('$e', 'bonjour')"
wait "$blocker" || fail "départ en vol : leave en erreur" "$tmp/15dl"
waitall
quiet "$tmp/15dl" "$tmp/15de" "$tmp/15dc"
got="$(member "$e") $(gp "$bt") $(score "$g") $(q -c "select count(*) from public.guild_chat_messages where user_id = '$e' and guild_id = '$g'") $(inv)"
[[ $got == "0 500 500 0 1 []" ]] || fail "départ en vol contre la fin : E membre, guildPoints, score de G, message, invariants : $got"
# e. kick(H), puis la fin de H : elle attend H, puis ne trouve plus d'appartenance.
i="$(player 15i)"
end_of "$h" "$i"
held 15ek "select wm.guild_kick('$l', '$h')"
bg 15ee "$fin"
wait "$blocker" || fail "exclusion en vol : kick en erreur" "$tmp/15ek"
waitall
quiet "$tmp/15ek" "$tmp/15ee"
got="$(member "$h") $(gp "$bt") $(score "$g") $(inv)"
[[ $got == "0 0 500 0 []" ]] || fail "exclusion en vol contre la fin : H membre, guildPoints, score de G, invariants : $got"
