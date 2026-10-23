-- ADDITIVE : signalements (R§3.7, R:258, M4b-2, M4b-8, M4b-10, M4b-31) — un par couple, modifiable, motifs de l'enum, détails de 500
-- caractères, clés étrangères prises dans l'ordre des profils. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Son signalement d'un joueur (R:258) : null s'il n'y en a pas, cible inconnue comprise.
create or replace function wm.report_get(p_uid uuid, p_reported_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('report', (select jsonb_build_object('reason', reason, 'details', details) from public.reports
    where reporter_id = p_uid and reported_user_id = p_reported_user_id))
$$;

-- Signalement (M4b-2) : actor seul, ni amitié ni notification. Les deux profils sont pris for key share dans l'ordre des id (M4b-31) :
-- l'insertion vérifie ses deux clés étrangères dans l'ordre de leurs triggers, et une acceptation entre les mêmes joueurs ferait un cycle.
create or replace function wm.report_upsert(p_uid uuid, p_reported_user_id uuid, p_reason text, p_details text default null,
  p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_reported_user_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas te signaler toi-même');
  end if;
  if p_reason is null or p_reason <> all (enum_range(null::public.report_reason)::text[]) then
    perform wm.raise_err(400, 'invalid_request', 'Motif de signalement inconnu');
  end if;
  if char_length(p_details) > 500 then
    perform wm.raise_err(400, 'invalid_request', 'Les détails font au plus 500 caractères');
  end if;
  if not exists (select from public.profiles where id = p_reported_user_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform from public.profiles where id in (p_uid, p_reported_user_id) order by id for key share;
  insert into public.reports (reporter_id, reported_user_id, reason, details)
  values (p_uid, p_reported_user_id, p_reason::public.report_reason, nullif(p_details, ''))
  on conflict (reporter_id, reported_user_id) do update set reason = excluded.reason, details = excluded.details;
  return wm.idem_store(p_uid, p_idem, wm.report_get(p_uid, p_reported_user_id));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
