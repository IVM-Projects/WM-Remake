-- ADDITIVE : pg_cron et les quatre jobs du marché (M3-1, P12), seulement si pg_cron est préchargé et proposé ; sinon rien, sans erreur.
-- Exception aux migrations wm : aucune fonction wm ici, donc ni les lignes revoke/grant finales (scan de 10_wm_core.test.sql) ; aucune
-- écriture de cron.job_run_details non plus, purgé par wm.purge_cron_history (1650). Idempotente : cron.schedule remplace un job du même nom.
-- Tout ou rien : une erreur annule l'extension et les jobs (avertissement), jamais le déploiement du marché qui l'entoure (M3-27).
-- Pas de pg_net au M3 (push au M4). Le banc et la CI sautent ce fichier (scripts/db-test.sh) ; 27_market.test.sql le rejoue sans pg_cron.
do $$
begin
  if current_setting('shared_preload_libraries') ~ '(^|,)\s*pg_cron\s*(,|$)'
     and exists (select from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    grant usage on schema cron to postgres;
    grant all privileges on all tables in schema cron to postgres;  -- lecture de wm.health, purge de wm.purge_cron_history
    perform cron.schedule('wm-settle', '10 seconds', 'select wm.settle_due_auctions(500)');
    perform cron.schedule('wm-wishlist-alerts', '10 seconds', 'select wm.wishlist_alerts_fanout(5000)');
    perform cron.schedule('wm-purge', '7 * * * *', 'select wm.purge_expired()');
    perform cron.schedule('wm-cron-history', '17 * * * *', 'select wm.purge_cron_history()');
  end if;
exception when others then
  raise warning '9000_wm_cron : pg_cron non installé, aucun job (% : %)', sqlstate, sqlerrm;
end $$;
