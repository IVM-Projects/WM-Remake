-- ADDITIVE : job wm-battle-expire toutes les 15 min (M5a-12), seulement si pg_cron est installé (par 9000) ; sinon rien, sans erreur.
-- Exception aux migrations wm, comme 9010:2-3 : aucune fonction wm ici (wm.expire_battles vit en 1940), donc ni les lignes revoke/grant
-- finales (scan de 10_wm_core.test.sql). Idempotente : cron.schedule remplace un job du même nom. Une erreur n'est qu'un avertissement, jamais
-- l'échec du déploiement qui l'entoure. Le banc et la CI sautent ce fichier (scripts/db-test.sh) ; 31_battles.test.sql le rejoue sans pg_cron.
do $$
begin
  if exists (select from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('wm-battle-expire', '4,19,34,49 * * * *', 'select wm.expire_battles(500)');
  end if;
exception when others then
  raise warning '9030_wm_battle_cron : job wm-battle-expire non posé (% : %)', sqlstate, sqlerrm;
end $$;
