-- Catalogue d'essai du développement (décision 4 du plan M1) : 2 000 cartes synthétiques, remplacées par le vrai catalogue au M2.
-- Idempotent. Appliqué par db-test.sh --setup-only (contrat, E2E), jamais par les tests SQL.

insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, q_score, pageviews, category, summary, hide_image, nsfw_image)
select 'Article d''essai n° ' || lpad(n::text, 4, '0'),
  'https://fr.wikipedia.org/wiki/Article_d''essai_n%C2%B0_' || lpad(n::text, 4, '0'),  -- encodeURIComponent du titre, espaces en _
  r.rarity,
  1000 + r.i * 1500 + n * 37 % 1500,  -- une bande de 1 500 par rareté, de 1 000 à 9 999
  1000 + r.i * 1500 + n * 53 % 1500,
  round(10 + r.i * 12 + n % 1000 / 100.0, 2),
  r.lo + n * 7919 % r.width,          -- vues dans la bande de la rareté (R§5.2)
  'Carte d''essai — ' || r.label,
  'Carte d''essai du catalogue de développement, remplacée par le vrai catalogue au M2.',
  n % 50 = 0, n % 97 = 0
from generate_series(1, 2000) n
join (values
  ('L'::public.rarity, 5, 'Légendaire', 1, 6, 20000, 180000),
  ('UR', 4, 'Ultra rare', 7, 30, 5000, 15000),
  ('SR', 3, 'Super rare', 31, 120, 1000, 4000),
  ('R', 2, 'Rare', 121, 400, 250, 750),
  ('PC', 1, 'Peu commune', 401, 1000, 50, 200),
  ('C', 0, 'Commune', 1001, 2000, 0, 50)
) r (rarity, i, label, first_n, last_n, lo, width) on n between r.first_n and r.last_n
on conflict (lang, wikipedia_title) do nothing;

select wm.rebuild_draw_pool();
