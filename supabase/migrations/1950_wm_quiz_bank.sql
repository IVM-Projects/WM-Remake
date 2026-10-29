-- ADDITIVE : file et écriture des banques générées (M5a-7, M5a-8, C12, C20) — quiz_next (remise en file, puis lecture), quiz_store
-- (banque llm revalidée par quiz_check), quiz_fail. Appelées par scripts/quiz/generate.ts avec la clé secrète. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- File du générateur (C12) : remet d'abord en file, en une instruction triée par card_id, chaque carte possédée (60) ou L, UR, SR (50,
-- 40, 30), à la plus haute de ses priorités (une ligne par carte, PF18), sauf banque llm ou retrait ; puis rend au plus 1 500 cartes
-- prêtes, en priority desc, pageviews desc, card_id. Ni actor ni maintenance.
create or replace function wm.quiz_next(p_limit int)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  -- La remise en file attend les insertions en vol de quiz_ensure.
  perform set_config('lock_timeout', '2s', true);
  -- shortcut: parcourt toutes les copies à chaque run, une table des cartes possédées au M8 si besoin.
  insert into wm.quiz_queue (card_id, priority)
  select c.id, greatest(case when exists (select from public.user_cards u where u.card_id = c.id) then 60 end,
    case c.rarity when 'L' then 50 when 'UR' then 40 when 'SR' then 30 end)
  from public.cards c
  where (c.rarity in ('L', 'UR', 'SR') or exists (select from public.user_cards u where u.card_id = c.id))
    and not exists (select from wm.card_quizzes q where q.card_id = c.id and q.source = 'llm')
    and not exists (select from wm.card_removals k where k.card_id = c.id)
  order by c.id
  on conflict do nothing;
  -- Hors banque llm : l'instruction (2) de quiz_ensure, dont l'instantané précède le commit d'un quiz_store, attend la ligne que celui-ci
  -- supprime puis la recrée à 100.
  -- shortcut: cette ligne orpheline reste comptée par wm.health() jusqu'à l'effacement de la banque ; cas rare, un nettoyage au M6 si /admin/health la montre.
  return (select coalesce(jsonb_agg(jsonb_build_object('card_id', x.id, 'page_id', x.page_id, 'title', x.wikipedia_title,
      'category', x.category, 'summary', x.summary, 'rarity', x.rarity) order by x.priority desc, x.pageviews desc, x.id), '[]')
    from (select c.id, s.page_id, c.wikipedia_title, c.category, c.summary, c.rarity, f.priority, c.pageviews
      from wm.quiz_queue f
      join public.cards c on c.id = f.card_id
      left join wm.card_source s on s.card_id = c.id
      where f.attempts < 3 and f.next_try_at <= now()
        and not exists (select from wm.card_removals k where k.card_id = f.card_id)
        and not exists (select from wm.card_quizzes q where q.card_id = f.card_id and q.source = 'llm')
      order by f.priority desc, c.pageviews desc, c.id
      limit least(greatest(p_limit, 0), 1500)) x);
end $$;

-- Banque générée d'une carte (C12, C20) : chaque question reçoit kind llm (une banque llm ne peut donc jamais sauter answer_is_title en
-- se disant views), puis passe quiz_check contre le titre ; upsert source llm, et la ligne de file supprimée.
create or replace function wm.quiz_store(p_card_id uuid, p_prompt_version int, p_model text, p_questions jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_title text; v_q jsonb := p_questions; v_rule text;
begin
  select wikipedia_title into v_title from public.cards where id = p_card_id;
  if not found then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  if coalesce(char_length(p_model), 0) not between 1 and 100 then
    perform wm.raise_err(400, 'invalid_request', 'Banque de questions invalide', '{"rule": "model"}');
  end if;
  if jsonb_typeof(v_q) = 'array' then
    v_q := (select coalesce(jsonb_agg(case when jsonb_typeof(q) = 'object' then q || '{"kind": "llm"}' else q end order by i), '[]')
      from jsonb_array_elements(v_q) with ordinality t (q, i));
  end if;
  v_rule := wm.quiz_check(v_q, v_title);
  if v_rule is not null then
    perform wm.raise_err(400, 'invalid_request', 'Banque de questions invalide', jsonb_build_object('rule', v_rule));
  end if;
  perform set_config('lock_timeout', '2s', true);
  insert into wm.card_quizzes (card_id, prompt_version, source, model, questions)
  values (p_card_id, p_prompt_version, 'llm', p_model, v_q)
  on conflict (card_id) do update set prompt_version = excluded.prompt_version, source = 'llm', model = excluded.model,
    questions = excluded.questions, created_at = now();
  delete from wm.quiz_queue where card_id = p_card_id;
  return '{"ok": true}';
end $$;

-- Échec d'une carte (C12) : attempts + 1, prochain essai dans attempts jours, last_error = un code de règle (jamais du contenu) coupé à
-- 200 caractères ; à 3 essais, quiz_next ne la propose plus.
create or replace function wm.quiz_fail(p_card_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform set_config('lock_timeout', '2s', true);
  update wm.quiz_queue set attempts = attempts + 1, next_try_at = now() + (attempts + 1) * interval '1 day', last_error = left(p_reason, 200)
  where card_id = p_card_id;
  return '{"ok": true}';
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
