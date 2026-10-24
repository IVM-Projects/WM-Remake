-- ADDITIVE : pg_net et le job wm-push-wake (M4b-17), seulement si pg_cron est installé (par 9000) et pg_net préchargé ; sinon rien, sans erreur.
-- Exception aux migrations wm, comme 9010:2 : aucune fonction wm ici (wm.push_wake vit en 1840), donc ni les lignes revoke/grant finales (scan
-- de 10_wm_core.test.sql). Idempotente : create extension if not exists, et cron.schedule remplace un job du même nom. Une erreur n'est qu'un
-- avertissement, jamais l'échec du déploiement qui l'entoure. Le banc et la CI sautent ce fichier (scripts/db-test.sh) ; 30_push.test.sql le
-- rejoue sans pg_cron. Arrêt d'urgence : cron.alter_job(jobid, active := false) sur wm-push-wake (M4b-22).
do $$
begin
  if exists (select from pg_extension where extname = 'pg_cron')
     and current_setting('shared_preload_libraries') ~ '(^|,)\s*pg_net\s*(,|$)' then
    create extension if not exists pg_net with schema extensions;  -- ses objets vivent de toute façon dans net
    perform cron.schedule('wm-push-wake', '15 seconds', 'select wm.push_wake()');
  end if;
exception when others then
  raise warning '9020_wm_push_cron : job wm-push-wake non posé (% : %)', sqlstate, sqlerrm;
end $$;
