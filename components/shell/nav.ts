import {
  BookOpen, Castle, Gavel, Globe, Handshake, Medal, MessageCircle, Puzzle, Settings, Swords, Trophy, User, Users,
  type LucideIcon,
} from 'lucide-react'

export type NavEntry = { href: string; label: string; icon: LucideIcon; title: string }

// Ordre exact de la barre latérale d'origine (R§2.2) ; `title` = h1 de la page.
export const NAV: readonly NavEntry[] = [
  { href: '/pulls', label: 'Paquets', icon: Puzzle, title: 'Paquets' },
  { href: '/collection', label: 'Collection', icon: BookOpen, title: 'Collection' },
  { href: '/trades', label: 'Échanges', icon: Handshake, title: 'Échanges' },
  { href: '/marketplace', label: 'Marché', icon: Gavel, title: 'Marché' },
  { href: '/profile', label: 'Profil', icon: User, title: 'Profil' },
  { href: '/global-collection', label: 'Toutes les cartes', icon: Globe, title: 'Collection Globale' },
  { href: '/guild', label: 'Guilde', icon: Castle, title: 'Guilde' },
  { href: '/friends', label: 'Amis', icon: Users, title: 'Amis' },
  { href: '/dms', label: 'Messages', icon: MessageCircle, title: 'Messages' },
  { href: '/battle', label: 'Bataille', icon: Swords, title: 'Bataille' },
  { href: '/achievements', label: 'Succès', icon: Trophy, title: 'Succès' },
  { href: '/leaderboard', label: 'Classement', icon: Medal, title: 'Classement' },
  { href: '/settings', label: 'Paramètres', icon: Settings, title: 'Paramètres' },
]

// Barre basse : les quatre premières entrées, les neuf autres dans la feuille « Plus ».
export const MOBILE_NAV = NAV.slice(0, 4)
export const MORE_NAV = NAV.slice(4)

export function navEntry(href: string): NavEntry {
  const entry = NAV.find((e) => e.href === href)
  if (!entry) throw new Error(`Entrée de navigation inconnue : ${href}`)
  return entry
}
