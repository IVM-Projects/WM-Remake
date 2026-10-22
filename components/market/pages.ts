import type { Auction } from './types'

// Une page lue (API) et la liste affichée d'un onglet : pages chargées, tuiles, reste-t-il une page (P17).
export type Page = { items: Auction[]; more: boolean }
export type List = { pages: number; items: Auction[]; more: boolean }

// Une enchère passée d'une page à l'autre entre deux lectures n'est gardée qu'une fois, à sa première place et avec sa dernière valeur
// (ids et clés React uniques, M3-2).
const unique = (items: Auction[]) => [...new Map(items.map((a) => [a.id, a])).values()]

// Relecture des pages 1..n (polling, affichage) : la liste devient ces pages fusionnées, une enchère disparue en sort. Ignorée si
// « Charger la suite » a changé le nombre de pages pendant la relecture : sa liste est plus complète.
export const mergeReread = (d: List | null, n: number, pages: Page[]): List | null =>
  d && d.pages !== n ? d : { pages: n, items: unique(pages.flatMap((p) => p.items)), more: pages[n - 1].more }

// « Charger la suite » parti avec n pages : la page n+1 s'ajoute, sauf si la liste a changé de nombre de pages entre-temps.
export const appendPage = (d: List | null, n: number, page: Page): List | null =>
  d && d.pages === n ? { pages: n + 1, items: unique([...d.items, ...page.items]), more: page.more } : d
