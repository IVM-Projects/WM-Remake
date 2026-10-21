# Fixtures du catalogue

Tranches réelles et cohérentes des sources Wikimedia pour un même ensemble d'environ 300 pages de Wikipédia en français (décision M2-7). Produites le 2026-10-21 par le mode `fixtures` de `.github/workflows/catalog.yml` (`node catalog/src/cli.ts fixtures …`) et commitées telles quelles ; `expected/` en est tiré par le pipeline.

## Sources

| Source | URL | Date |
|---|---|---|
| Wikipédia en français, dump SQL `page` | https://dumps.wikimedia.org/frwiki/latest/frwiki-latest-page.sql.gz | 2026-10-01 |
| Wikipédia en français, dump SQL `page_props` | https://dumps.wikimedia.org/frwiki/latest/frwiki-latest-page_props.sql.gz | 2026-10-01 |
| Vues mensuelles (`pageview_complete`, `user`) | https://dumps.wikimedia.org/other/pageview_complete/monthly/2026/2026-09/pageviews-202609-user.bz2 | 2026-09 |
| CirrusSearch (`frwiki_content`, 21 parts) | https://dumps.wikimedia.org/other/cirrus_search_index/20261018/index_name%3Dfrwiki_content/ | 2026-10-18 |
| Wikidata (`wbgetentities`, descriptions) | https://www.wikidata.org/w/api.php | 2026-10-21 |
| Wikimedia Commons (`imageinfo`, `extmetadata`) | https://commons.wikimedia.org/w/api.php | 2026-10-21 |
| Wikipédia en français (`imageinfo` des fichiers locaux, TextExtracts) | https://fr.wikipedia.org/w/api.php | 2026-10-21 |

## Licences

- Textes de Wikipédia (`page.sql`, `page_props.sql`, `cirrus.ndjson`, `extracts.json`) : contributeurs de Wikipédia, sous licence CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/deed.fr) ; l'historique de chaque article sur fr.wikipedia.org nomme ses auteurs.
- Descriptions de Wikidata (`wikidata.json`) : CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/deed.fr).
- Vues (`pageviews.txt`) : fichier mensuel `user` de `pageview_complete` du mois 2026-09 (https://dumps.wikimedia.org/other/pageview_complete/monthly/AAAA/AAAA-MM/pageviews-AAAAMM-user.bz2), sous CC0 1.0 comme tous les jeux de données Analytics de Wikimedia (https://dumps.wikimedia.org/other/pageview_complete/readme.html).
- Métadonnées des images (`commons.json`) : sous la licence de chaque fichier, donnée dans la réponse elle-même (`LicenseShortName`, `LicenseUrl`).

## Contenu de `raw/`

- `ids.tsv` : `page_id` et raison du choix (`hash` : les 250 plus petits hachages FNV-1a ; `L`, `UR`, `SR`, `R` : 10 pages de chaque rareté ; `AdQ`, `BA`, `svg` : 3 pages chacune).
- `page.sql`, `page_props.sql` : tuples de ces pages réécrits au format du dump (en-tête d'origine, un tuple par ligne). `page.sql` garde aussi quelques redirections, pages d'autres espaces de noms et homonymies, que le pipeline doit écarter.
- `pageviews.txt` : lignes `fr.wikipedia` du fichier mensuel `user` pour ces pages (par `page_id`, ou par titre quand `page_id` vaut `null`).
- `cirrus.ndjson` : paires index/document du dump CirrusSearch pour ces pages. Les champs lourds (`source_text`, `text`, `auxiliary_text`, …) sont retirés ; restent `page_id`, `namespace`, `title`, `page_type`, `redirect_target`, `opening_text`, `text_bytes`, `incoming_links`, `template`, `wikibase_item`, `version`, `timestamp`, `index_name`, `wiki`.
- `wikidata.json`, `commons.json`, `extracts.json` : réponses des API, rangées par l'URL exacte de la requête.
- `meta.json` : date du run, mois des vues (`YYYY-MM`), date de l'instantané Cirrus.

Projet indépendant de la Fondation Wikimedia.
