-- ADDITIVE : job horaire wm-trade-expire (M4-5), seulement si pg_cron est installé (par 9000) ; sinon rien, sans erreur.
-- Exception aux migrations wm, comme 9000:2-3 : aucune fonction wm ici, donc ni les lignes revoke/grant finales (scan de 10_wm_core.test.sql).
-- Idempotente : cron.schedule remplace un job du même nom. Une erreur n'est qu'un avertissement, jamais l'échec du déploiement qui l'entoure.
-- Le banc et la CI sautent ce fichier (scripts/db-test.sh) ; 28_trades.test.sql le rejoue sans pg_cron.
do $$
begin
  if exists (select from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('wm-trade-expire', '27 * * * *', 'select wm.expire_trades(5000)');
  end if;
exception when others then
  raise warning '9010_wm_trade_cron : job wm-trade-expire non posé (% : %)', sqlstate, sqlerrm;
end $$;
