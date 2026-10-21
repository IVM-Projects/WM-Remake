-- χ² de wm.pick_card (M2-11), inclus par 25_pool et lancé tel quel sur la démo : 100 000 tirages au prorata de n_r.
-- Rareté contre n_r / N ; seq de la rareté la plus nombreuse en 20 classes égales, attendu proportionnel à la largeur de la classe.
-- Vue temporaire : chaque lecture refait les tirages ; setseed juste avant la lecture pour la rendre reproductible.
create temp view chi2 as
with t as materialized (select wm.pick_card(null, '{}') card_id from generate_series(1, 100000)),
d as materialized (select p.rarity, p.seq from t join wm.draw_pool p using (card_id)),
s as (select rarity, n, n::float8 / sum(n) over () share from wm.catalog_stats where n > 0),
r as (select s.share * (select count(*) from t) e, count(d.rarity) o from s left join d using (rarity) group by s.rarity, s.share),
b as (select rarity, n from s order by n desc, rarity limit 1),
-- Classe de seq : (seq − 1) · 20 / n en division entière, de 0 à 19.
w as (select (g - 1) * 20 / b.n k, count(*)::float8 / b.n share from b, generate_series(1, b.n) g group by 1, b.n),
o as (select (d.seq - 1) * 20 / b.n k, count(*) o from d join b using (rarity) group by 1),
q as (select w.share * (select coalesce(sum(o), 0) from o) e, coalesce(o.o, 0) o from w left join o using (k))
select (select count(*) from t) draws,
  (select sum((o - e) ^ 2 / e) from r) chi2_rarity, (select count(*) - 1 from r) df_rarity,
  (select sum((o - e) ^ 2 / e) from q) chi2_seq, (select count(*) - 1 from q) df_seq;
