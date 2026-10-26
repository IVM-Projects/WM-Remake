-- ADDITIVE : la partie (D§7.7, R§3.9, M5a-2, M5a-8, M5a-10, M5a-11, C4, C5, C7, C8, C10, C11, C18, C19) — vainqueur, fin et récompenses,
-- deck figé, attaque à 3 questions tirées, réponses une à une, abandon. Les sous-fonctions de battle_action (1920) reçoivent la bataille
-- déjà tenue : aucune ne la relit ni ne pose de délai de verrou, et seules la dernière réponse et l'abandon prennent les profils. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Vainqueur (C8), pur : KO, puis le meilleur ratio de PV en produit en croix (entiers), puis les PV bruts, puis le défenseur du dernier tour.
create or replace function wm.battle_winner(p_state jsonb, p_challenger uuid, p_opponent uuid)
returns uuid language sql immutable security definer set search_path = '' as $$
  select case
    when o.hp = 0 then p_challenger
    when c.hp = 0 then p_opponent
    when c.hp * o.mx <> o.hp * c.mx then case when c.hp * o.mx > o.hp * c.mx then p_challenger else p_opponent end
    when c.hp <> o.hp then case when c.hp > o.hp then p_challenger else p_opponent end
    else (p_state #>> '{turnHistory,-1,defenderId}')::uuid end
  from (select (p_state #>> array['players', p_challenger::text, 'currentHp'])::bigint hp,
      (p_state #>> array['players', p_challenger::text, 'maxHp'])::bigint mx) c,
    (select (p_state #>> array['players', p_opponent::text, 'currentHp'])::bigint hp,
      (p_state #>> array['players', p_opponent::text, 'maxHp'])::bigint mx) o
$$;

-- Fin de partie (M5a-2), appelée bataille et deux profils tenus : completed seulement depuis active (sinon XX000, jamais atteint par un
-- appelant correct), reward_win et reward_loss par wallet_apply par id croissant (M4-4), battles_won par upsert (user_stats absente d'un
-- profil migré, C19), battle_won et battle_lost (C10).
create or replace function wm.battle_finish(p_battle_id uuid, p_winner uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := (select value from wm.config where key = 'battle');
  b public.battles;
  v_loser uuid;
  v_u uuid;
begin
  update public.battles set status = 'completed', winner_id = p_winner, updated_at = clock_timestamp(),
    game_state = game_state || jsonb_build_object('phase', 'over', 'winnerId', p_winner, 'pendingAttack', null)
  where id = p_battle_id and status = 'active'
  returning * into b;
  if not found then
    raise exception 'battle_finish : bataille % non active', p_battle_id using errcode = 'XX000';
  end if;
  v_loser := case when p_winner = b.challenger_id then b.opponent_id else b.challenger_id end;
  -- shortcut: +500 points de guilde au M5b (M5a-2), branchés ici.
  for v_u in select u from unnest(array[b.challenger_id, b.opponent_id]) u order by u loop
    perform wm.wallet_apply(v_u, (c ->> case when v_u = p_winner then 'reward_win' else 'reward_loss' end)::int, 'battle', 'battle:' || b.id);
  end loop;
  insert into wm.user_stats as s (user_id, battles_won) values (p_winner, 1)
  on conflict (user_id) do update set battles_won = s.battles_won + 1;
  -- Deux insertions hors de l'ordre des id (P28) sans risque : l'appelant tient déjà les deux profils en exclusif (lock_users).
  perform wm.notify_battle(array[p_winner], 'battle_won', b.id, v_loser);
  perform wm.notify_battle(array[v_loser], 'battle_lost', b.id, p_winner);
end $$;

-- submit_deck (C4, M5a-11) : chaque id est une copie de l'appelant (une seule ligne trouvée), sinon un id catalogue (sa copie au plus grand
-- snapshot_def, puis au plus petit id) ; faces figées, PV = Σ DEF. Les deux profils for key share avant la première écriture (M4b-31) :
-- battle_decks prend celui de l'appelant, battle_started l'autre. Le premier deck n'appelle pas quiz_ensure (la file est lisible de dehors) ;
-- le second assure les banques des deux decks en un appel, puis passe la bataille active (C18).
create or replace function wm.battle_submit_deck(b public.battles, p_uid uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text := wm.battle_read_status(b);
  v_other uuid := case when p_uid = b.challenger_id then b.opponent_id else b.challenger_id end;
  v_cards uuid[];
  v_faces jsonb;
  v_hp int;
  v_n int;
  v_state jsonb;
begin
  if v_status = 'pending' then
    perform wm.raise_err(409, null, 'Ce défi n''est pas encore accepté');
  elsif v_status = 'active' then
    perform wm.raise_err(409, null, 'Le choix des cartes est terminé');
  elsif v_status in ('completed', 'cancelled') then
    perform wm.raise_err(409, null, 'Cette bataille est terminée');
  end if;
  if b.game_state -> 'players' ? p_uid::text then
    perform wm.raise_err(409, null, 'Ton deck est déjà validé');
  end if;
  if coalesce(jsonb_array_length(case when jsonb_typeof(p_payload -> 'card_ids') = 'array' then p_payload -> 'card_ids' end), 0) <> 3 then
    perform wm.raise_err(400, 'invalid_request', 'Choisis 3 cartes');
  end if;
  select array_agg(k.card_id order by x.o), sum(k.snapshot_def), count(k.id),
    jsonb_agg(jsonb_build_object('id', k.card_id, 'user_card_id', k.id, 'wikipedia_title', k.snapshot_title, 'wikipedia_url', c.wikipedia_url,
      'rarity', k.snapshot_rarity, 'atk', k.snapshot_atk, 'def', k.snapshot_def, 'image_url', c.image_url, 'hide_image', c.hide_image,
      'nsfw_image', c.nsfw_image) order by x.o)
  into v_cards, v_hp, v_n, v_faces
  from (select o, case when v ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then v::uuid end id
    from jsonb_array_elements_text(p_payload -> 'card_ids') with ordinality t (v, o)) x
  left join lateral (select uc.id, uc.card_id, uc.snapshot_title, uc.snapshot_rarity, uc.snapshot_atk, uc.snapshot_def
    from public.user_cards uc where uc.user_id = p_uid and (uc.id = x.id or uc.card_id = x.id)
    order by uc.snapshot_def desc, uc.id limit 1) k on true
  left join public.cards c on c.id = k.card_id;
  if v_n < 3 then
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  if (select count(distinct u) from unnest(v_cards) u) < 3 then
    perform wm.raise_err(400, 'invalid_request', 'Choisis 3 cartes différentes');
  end if;
  perform from public.profiles where id in (b.challenger_id, b.opponent_id) order by id for key share;
  insert into public.battle_decks (battle_id, user_id, card_ids) values (b.id, p_uid, v_cards);
  v_state := jsonb_set(b.game_state, array['players', p_uid::text], jsonb_build_object('cardIds', to_jsonb(v_cards), 'usedCardIds', '[]'::jsonb,
    'currentHp', v_hp, 'maxHp', v_hp, 'cards', v_faces));
  if not v_state -> 'players' ? v_other::text then
    update public.battles set game_state = v_state, updated_at = clock_timestamp() where id = b.id;
    return;
  end if;
  perform wm.quiz_ensure(array(select unnest(card_ids) from public.battle_decks where battle_id = b.id));
  update public.battles set status = 'active', updated_at = clock_timestamp(),
    game_state = v_state || jsonb_build_object('phase', 'attack', 'currentTurnUserId', b.challenger_id, 'turnNumber', 1)
  where id = b.id;
  perform wm.notify_battle(array[v_other], 'battle_started', b.id, p_uid);
end $$;

-- submit_attack (C7) : une carte du deck de l'attaquant (card_id ou user_card_id de sa face), pas encore engagée. Le défenseur for key share
-- avant les banques et toute écriture (Global Constraints, « Verrous ») ; banque effacée par le staff → quiz_ensure d'abord. Questions tirées
-- d'abord parmi celles de cette carte pas encore tirées dans cette bataille ; bonnes options dans battle_secrets seulement (M5a-10).
create or replace function wm.battle_submit_attack(b public.battles, p_uid uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text := wm.battle_read_status(b);
  v_me jsonb := b.game_state -> 'players' -> p_uid::text;
  v_def uuid := case when p_uid = b.challenger_id then b.opponent_id else b.challenger_id end;
  v_face jsonb;
  v_card uuid;
  v_bank jsonb;
  v_draw jsonb;
begin
  if v_status in ('completed', 'cancelled') then
    perform wm.raise_err(409, null, 'Cette bataille est terminée');
  elsif v_status = 'pending' then
    perform wm.raise_err(409, null, 'Ce défi n''est pas encore accepté');
  elsif v_status <> 'active' then
    perform wm.raise_err(409, null, 'La bataille n''a pas commencé');
  end if;
  if b.game_state ->> 'phase' is distinct from 'attack' or b.game_state ->> 'currentTurnUserId' is distinct from p_uid::text then
    perform wm.raise_err(409, null, 'Ce n''est pas à toi d''attaquer');
  end if;
  select f into v_face from jsonb_array_elements(v_me -> 'cards') f where p_payload ->> 'attack_card_id' in (f ->> 'id', f ->> 'user_card_id');
  if not found then
    perform wm.raise_err(400, 'invalid_request', 'Cette carte n''est pas dans ton deck');
  end if;
  if v_me -> 'usedCardIds' ? (v_face ->> 'id') then
    perform wm.raise_err(409, null, 'Cette carte a déjà attaqué');
  end if;
  v_card := (v_face ->> 'id')::uuid;
  perform from public.profiles where id = v_def for key share;
  select questions into v_bank from wm.card_quizzes where card_id = v_card;
  if not found then
    perform wm.quiz_ensure(array[v_card]);
    select questions into v_bank from wm.card_quizzes where card_id = v_card;
  end if;
  select jsonb_agg(d || jsonb_build_object('id', gen_random_uuid()) order by o) into v_draw
  from jsonb_array_elements(wm.quiz_draw(v_bank,
      array(select q_index::int from wm.battle_secrets where battle_id = b.id and card_id = v_card),
      (select (value ->> 'questions')::int from wm.config where key = 'battle'))) with ordinality t (d, o);
  insert into wm.battle_secrets (battle_id, question_id, turn_number, defender_id, card_id, q_index, correct_option_id)
  select b.id, (d ->> 'id')::uuid, (b.game_state ->> 'turnNumber')::smallint, v_def, v_card, (d ->> 'q_index')::smallint, d ->> 'correct_option_id'
  from jsonb_array_elements(v_draw) d;
  update public.battles set updated_at = clock_timestamp(),
    game_state = jsonb_set(b.game_state, array['players', p_uid::text, 'usedCardIds'], (v_me -> 'usedCardIds') || to_jsonb(v_card))
      || jsonb_build_object('phase', 'quiz', 'pendingAttack', jsonb_build_object('attackerUserId', p_uid, 'defenderId', v_def,
        'attackCardId', v_card, 'attackCardName', v_face -> 'wikipedia_title', 'answered', '[]'::jsonb,
        'questions', (select jsonb_agg(jsonb_build_object('id', d -> 'id', 'prompt', d -> 'prompt', 'options', d -> 'options') order by o)
          from jsonb_array_elements(v_draw) with ordinality t (d, o))))
  where id = b.id;
  perform wm.notify_battle(array[v_def], 'battle_attacked', b.id, p_uid);
end $$;

-- submit_single_answer (C5, C8, C11) → {correct, correct_answer_id, last_turn, status}. Le secret d'abord : déjà répondu par l'appelant, le
-- rejeu (rien n'est écrit) ; puis statut, rôle et option. La dernière réponse du tour fait les dégâts ; un KO ou la fin du 6ᵉ tour prend les
-- deux profils (lock_users) et finit la partie.
create or replace function wm.battle_answer(b public.battles, p_uid uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s wm.battle_secrets;
  pa jsonb := b.game_state -> 'pendingAttack';
  v_state jsonb;
  v_last boolean;
  v_end boolean := false;
  v_turn int := (b.game_state ->> 'turnNumber')::int;
  v_wrong int;
  v_total int;
  v_dmg int;
  v_hp int;
begin
  select * into s from wm.battle_secrets where battle_id = b.id and question_id::text = p_payload ->> 'questionId';
  if not found then
    perform wm.raise_err(400, 'invalid_request', 'Question inconnue');
  end if;
  if s.answered_at is not null then
    if s.defender_id <> p_uid then
      perform wm.raise_err(409, null, 'Aucune question ne t''attend');
    end if;
    return jsonb_build_object('correct', s.correct, 'correct_answer_id', s.correct_option_id,
      'last_turn', not exists (select from wm.battle_secrets where battle_id = b.id and turn_number = s.turn_number and answered_at is null),
      'status', wm.battle_read_status(b));
  end if;
  if wm.battle_read_status(b) in ('completed', 'cancelled') then
    perform wm.raise_err(409, null, 'Cette bataille est terminée');
  end if;
  if b.game_state ->> 'phase' is distinct from 'quiz' or pa ->> 'defenderId' is distinct from p_uid::text then
    perform wm.raise_err(409, null, 'Aucune question ne t''attend');
  end if;
  if not exists (select from jsonb_array_elements(pa -> 'questions') q, jsonb_array_elements(q -> 'options') o
      where q ->> 'id' = s.question_id::text and o ->> 'id' = p_payload ->> 'answerId') then
    perform wm.raise_err(400, 'invalid_request', 'Réponse inconnue');
  end if;
  update wm.battle_secrets set answer_id = p_payload ->> 'answerId', correct = p_payload ->> 'answerId' = correct_option_id,
    answered_at = clock_timestamp()
  where battle_id = b.id and question_id = s.question_id
  returning * into s;
  pa := jsonb_set(pa, '{answered}', (pa -> 'answered') || to_jsonb(s.question_id));
  v_last := jsonb_array_length(pa -> 'answered') = jsonb_array_length(pa -> 'questions');
  v_state := jsonb_set(b.game_state, '{pendingAttack}', pa);
  if v_last then
    select count(*) filter (where not correct), count(*) into v_wrong, v_total
    from wm.battle_secrets where battle_id = b.id and turn_number = s.turn_number;
    v_dmg := round((select (f ->> 'atk')::int from jsonb_array_elements(b.game_state -> 'players' -> (pa ->> 'attackerUserId') -> 'cards') f
      where f ->> 'id' = pa ->> 'attackCardId') * v_wrong::numeric / v_total);
    v_hp := greatest(0, (b.game_state -> 'players' -> (pa ->> 'defenderId') ->> 'currentHp')::int - v_dmg);
    v_state := jsonb_set(v_state, array['players', pa ->> 'defenderId', 'currentHp'], to_jsonb(v_hp))
      || jsonb_build_object('turnHistory', (v_state -> 'turnHistory') || jsonb_build_object('turnNumber', v_turn,
        'attackerUserId', pa -> 'attackerUserId', 'defenderId', pa -> 'defenderId', 'attackCardId', pa -> 'attackCardId',
        'allCorrect', v_wrong = 0, 'damageDealt', v_dmg, 'wrong', v_wrong, 'total', v_total));
    -- C8 : la partie finit au KO ou après le 6ᵉ tour.
    v_end := v_hp = 0 or v_turn >= 6;
    if not v_end then
      v_state := v_state || jsonb_build_object('phase', 'attack', 'currentTurnUserId', pa -> 'defenderId', 'turnNumber', v_turn + 1,
        'pendingAttack', null);
    end if;
  end if;
  update public.battles set game_state = v_state, updated_at = clock_timestamp() where id = b.id;
  if v_end then
    perform wm.lock_users(array[b.challenger_id, b.opponent_id]);
    perform wm.battle_finish(b.id, wm.battle_winner(v_state, b.challenger_id, b.opponent_id));
  end if;
  return jsonb_build_object('correct', s.correct, 'correct_answer_id', s.correct_option_id, 'last_turn', v_last,
    'status', case when v_end then 'completed' else 'active' end);
end $$;

-- forfeit en active (M5a-12) : l'autre joueur gagne, récompenses normales. Une bataille close est refusée avant, par battle_action.
create or replace function wm.battle_forfeit(b public.battles, p_uid uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform wm.lock_users(array[b.challenger_id, b.opponent_id]);
  perform wm.battle_finish(b.id, case when p_uid = b.challenger_id then b.opponent_id else b.challenger_id end);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
