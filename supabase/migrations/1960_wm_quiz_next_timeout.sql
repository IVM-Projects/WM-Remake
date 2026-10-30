-- ADDITIVE : délai propre à wm.quiz_next (livraison M5a). Sa remise en file parcourt les 117 000 cartes du catalogue : 150 ms dans une
-- connexion chaude, mais 3 à 8 s au premier appel d'une connexion neuve de PostgREST, au-delà des 8 s d'authenticator (run 41035707383,
-- 57014). PostgREST applique le statement_timeout d'une fonction à son appel ; 60 s est le plafond de l'API. Seule fonction exemptée
-- (10_wm_core.test.sql). Un 1950 rejoué (create or replace) efface ce réglage : le rejouer suivi de 1960.
alter function wm.quiz_next(int) set statement_timeout = '60s';
