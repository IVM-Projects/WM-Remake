-- ADDITIVE : dotation de départ de 10 paquets (décision de l'utilisateur du 2026-10-26, écart à D:369) — clé wm.config.start_packs, posée par
-- wm.handle_new_user à l'inscription, bornée par pack_cap ; réserve pleine → horloge nulle, sinon démarrée à l'inscription (règle de
-- wm.apply_regen). Le défaut du miroir (profiles.packs_remaining = 1) n'est pas touché ; les comptes existants ne changent pas. Même
-- signature, même corps et même réponse qu'en 1100 (déployée, non retouchée), plus l'update de la dotation. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

insert into wm.config (key, value, note) values
  ('start_packs', '10', 'Dotation de départ en paquets, décision de l''utilisateur du 2026-10-26 (écart à D:369)')
on conflict do nothing;

-- Inscription GoTrue (D§7.1) : un refus lève P0001, que GoTrue relaie en 500 avec message et detail.
create or replace function wm.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}');
begin
  if m -> 'age_confirmed' is distinct from 'true'::jsonb or coalesce(btrim(m ->> 'terms_version'), '') = '' then
    perform wm.raise_err(400, 'consent_required', 'Confirme avoir au moins 18 ans et accepte les conditions.');
  end if;
  perform wm.raise_username(wm.username_problem(m ->> 'username'));
  begin
    insert into public.profiles (id, username) values (new.id, m ->> 'username');
  exception when unique_violation then  -- inscription concurrente passée entre la vérification et l'insertion
    perform wm.raise_username('taken');
  end;
  -- Dotation (1870) sur le pack_cap de la ligne ; clé absente → défaut du miroir.
  update public.profiles set packs_remaining = least(s.n, pack_cap), packs_last_regen_at = case when s.n < pack_cap then now() end
  from (select value::int n from wm.config where key = 'start_packs') s
  where id = new.id;
  perform wm.lock_user(new.id);  -- crée les lignes wm
  return null;
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
