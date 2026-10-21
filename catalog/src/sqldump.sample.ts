// Échantillon du dump SQL de frwiki écrit à la main, partagé par les tests de sqldump et de fixtures.
// Format réel du dump du 2026-10-01 (notes-external.md §1) : MariaDB-dump 10.19, un tuple par ligne.
const HEADER = [
  String.raw`/*M!999999\- enable the sandbox mode */ `,
  '-- MariaDB dump 10.19  Distrib 10.11.18-MariaDB, for debian-linux-gnu (x86_64)',
  '',
]
export const PAGE_CREATE = [
  '  `page_id` int(8) unsigned NOT NULL AUTO_INCREMENT,',
  '  `page_namespace` int(11) NOT NULL DEFAULT 0,',
  "  `page_title` varbinary(255) NOT NULL DEFAULT '',",
  '  `page_is_redirect` tinyint(1) unsigned NOT NULL DEFAULT 0,',
  '  `page_is_new` tinyint(1) unsigned NOT NULL DEFAULT 0,',
  '  `page_random` double unsigned NOT NULL DEFAULT 0,',
  '  `page_touched` binary(14) NOT NULL,',
  '  `page_links_updated` binary(14) DEFAULT NULL,',
  '  `page_latest` int(8) unsigned NOT NULL DEFAULT 0,',
  '  `page_len` int(8) unsigned NOT NULL DEFAULT 0,',
  '  `page_content_model` varbinary(32) DEFAULT NULL,',
  '  `page_lang` varbinary(35) DEFAULT NULL,',
  '  PRIMARY KEY (`page_id`),',
  ') ENGINE=InnoDB AUTO_INCREMENT=17639867 DEFAULT CHARSET=binary ROW_FORMAT=COMPRESSED;',
]
export const PROPS_CREATE = [
  '  `pp_page` int(10) unsigned NOT NULL,',
  "  `pp_propname` varbinary(60) NOT NULL DEFAULT '',",
  '  `pp_value` blob NOT NULL,',
  '  `pp_sortkey` float DEFAULT NULL,',
  '  PRIMARY KEY (`pp_page`,`pp_propname`),',
  ') ENGINE=InnoDB DEFAULT CHARSET=binary ROW_FORMAT=COMPRESSED;',
]
export const PAGE_TUPLES = [
  String.raw`(3,0,'Antoine_Meillet',0,0,0.792197141602819,'20260930180248','20260930205913',235942045,16467,'wikitext',NULL)`,
  String.raw`(16,0,'Arc_de_triomphe_de_l\'Étoile',0,0,0.75402497849802,'20260930180248','20260929102857',239871489,67657,'wikitext',NULL)`,
  String.raw`(21,0,'Sigles_en_médecine',1,0,0.865262672179623,'20260928201612','20250708210134',227125274,48,'wikitext',NULL)`,
  String.raw`(40,1,'Discussion_test',0,0,0.5,'20260930180248',NULL,1,10,'wikitext',NULL)`,
]
export const PROPS_TUPLES = [
  String.raw`(11,'page_image_free','Palacio_del_Congreso_in_Buenos_Aires_(6370115601).jpg',NULL)`,
  String.raw`(11,'wikibase_item','Q1154647',NULL)`,
  String.raw`(12,'page_image_free','Hogan\'s_Flying_Column.gif',NULL)`,
  String.raw`(18,'wikibase-badge-Q17437796','',NULL)`,
  String.raw`(48,'disambiguation','',NULL)`,
  String.raw`(49,'wikibase-badge-Q17437798','',NULL)`,
  String.raw`(50,'page_image','Non_libre.jpg',NULL)`,
  // AdQ et BA sur la même page : le plus haut gagne.
  String.raw`(60,'wikibase-badge-Q17437796','',NULL)`,
  String.raw`(60,'wikibase-badge-Q17437798','',NULL)`,
  String.raw`(1264,'kartographer_links','1',1)`,
]

export function dump(table: string, create: string[], tuples: string[], oneLine = false): string {
  const insert = `INSERT INTO \`${table}\` VALUES`
  const values = oneLine
    ? [`${insert} ${tuples.join(',')};`]
    : [insert, ...tuples.map((t, i) => t + (i < tuples.length - 1 ? ',' : ';'))]
  return [...HEADER, `CREATE TABLE \`${table}\` (`, ...create, ...values, ''].join('\n')
}
