'use client'

import { Shield, Star, Swords, Users } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { brand } from '@/lib/brand'
import { formatInt } from '@/lib/format'
import { usePrefs } from '@/lib/prefs'
import { rarityOf, type RarityCode } from '@/lib/rarity'

// Ce que la carte affiche. Copie possédée : rareté, titre et stats du snapshot (C11) ; catalogue : la carte telle quelle.
export type CardFace = {
  wikipedia_title: string
  rarity: RarityCode
  category?: string | null
  atk?: number | null
  def?: number | null
  image_url?: string | null
  hide_image?: boolean | null
  nsfw_image?: boolean | null
}

type Props = {
  card: CardFace
  size?: 'lg' | 'grid'
  owned?: boolean
  starred?: boolean
  onToggleStar?: () => void
  // Étoile inactive mais focalisable (aria-disabled) : le parent garde aussi onToggleStar.
  starOff?: boolean
  count?: number
  isShiny?: boolean
  friendOwner?: string
  onClick?: () => void
  // Modale : le p porte l'extrait de l'article au lieu de la description courte.
  excerpt?: string | null
}

const SIZES = {
  lg: { root: 'w-72 h-[420px]', h3: 'text-base', p: 'text-[11px] line-clamp-3', stats: 'text-sm', icon: 'size-4', star: 'size-7' },
  grid: {
    root: 'w-[clamp(8.4rem,43vw,10rem)] h-[clamp(11.8rem,60vw,14rem)]',
    h3: 'text-xs', p: 'text-[9px] line-clamp-3', stats: 'text-[10px]', icon: 'size-3', star: 'size-[1.375rem]',
  },
}

// Image affichée selon ses drapeaux (une image qui ne charge pas est masquée à part, `broken`) ; la modale ne demande le crédit qu'à cette condition (card_credits ne lit pas les drapeaux).
export const showsImage = (card: Pick<CardFace, 'image_url' | 'hide_image' | 'nsfw_image'>, hideSensitive: boolean): boolean =>
  !!card.image_url && !card.hide_image && !(card.nsfw_image && hideSensitive)

// DOM de R§6.4 : classes, ordre des enfants et aria-label sont un contrat avec les extensions (docs/DESIGN.md).
export function Card({ card, size = 'lg', owned, starred, onToggleStar, starOff, count = 1, isShiny, friendOwner, onClick, excerpt }: Props) {
  const { hideSensitive } = usePrefs()
  // Miniature introuvable ou refusée (fichier Commons supprimé) : l'emblème plutôt que l'icône d'image cassée.
  const [broken, setBroken] = useState<string | null>(null)
  const r = rarityOf(card.rarity)
  const s = SIZES[size]
  const color = `var(--color-rarity-${r.css})`
  const title = card.wikipedia_title
  const image = showsImage(card, hideSensitive) && card.image_url !== broken && card.image_url
  const text = excerpt ?? card.category
  return (
    <div
      className={`${s.root} glow-${r.css} relative rounded-2xl overflow-hidden cursor-pointer hover:z-10 transition-all duration-300 hover:scale-105 motion-reduce:hover:scale-100`}
      onClick={onClick}
      // Carte non cliquable (modale, révélation) : les classes du contrat restent, l'invitation au clic non.
      style={onClick ? undefined : { cursor: 'default', scale: 'none' }}
    >
      {/* 1. Fond de rareté en CSS (D§8.5), à la place de l'img de fond d'origine. */}
      <div className={`absolute inset-0 rarity-bg-${r.css}`} aria-hidden="true" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-transparent pointer-events-none z-10" />
      <div className="absolute top-0 left-0 right-0 h-[45%] z-20 bg-black/20">
        {image ? (
          <div className="relative h-full w-full min-h-0">
            {/* Miniature Wikimedia en lien direct, sans l'optimiseur de Next (D§8.5). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt={title}
              crossOrigin="anonymous"
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
              style={{ objectPosition: 'center 28%' }}
              onError={() => setBroken(image)}
              // Erreur survenue avant l'hydratation : onError ne la verra jamais.
              ref={(el) => { if (el?.complete && !el.naturalWidth) setBroken(image) }}
            />
            <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-black/50 to-transparent" />
          </div>
        ) : (
          <Emblem />
        )}
      </div>
      <div
        className="absolute top-2 left-2 px-2 py-0.5 rounded-md text-xs font-bold z-30"
        style={{ backgroundColor: color, color: 'rgb(13,17,23)', boxShadow: `0 0 10px ${color}99` }}
      >
        {r.code}
      </div>
      {(owned || count > 1 || isShiny) && (
        <div className="absolute top-2 right-2 z-30 flex flex-col items-end gap-1">
          {owned && (
            <button
              type="button"
              aria-label={starred ? 'Retirer des favoris' : 'Ajouter aux favoris'}
              disabled={!onToggleStar}
              aria-disabled={starOff || undefined}
              onClick={(e) => {
                e.stopPropagation()
                onToggleStar?.()
              }}
              // Anneau de focus à l'intérieur : la carte (overflow-hidden) le couperait. ::after agrandit la cible vers l'intérieur de la carte, à 44 px au moins (D§8.6).
              className="relative -m-2 inline-flex items-center justify-center rounded-full p-2 after:absolute after:top-0 after:right-0 after:-bottom-1.5 after:-left-1.5 focus-visible:-outline-offset-2 disabled:cursor-default aria-disabled:cursor-progress"
            >
              <Star
                className={`${s.star} drop-shadow-[0_1px_2px_rgb(0_0_0/0.6)] ${starred ? 'text-amber-200' : 'text-amber-200/65'}`}
                fill={starred ? 'currentColor' : 'none'}
              />
            </button>
          )}
          {count > 1 && (
            <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white tabular-nums">x{count}</span>
          )}
          {isShiny && (
            <span role="img" aria-label="Brillante" title="Brillante" className="text-sm leading-none drop-shadow-[0_1px_2px_rgb(0_0_0/0.6)]">
              ✨
            </span>
          )}
        </div>
      )}
      <div className="absolute top-[45%] left-0 right-0 bottom-0 flex min-h-0 flex-col p-3 z-20">
        <h3 className={`shrink-0 font-bold leading-tight line-clamp-2 text-black ${s.h3}`} style={{ fontFamily: 'var(--font-heading)' }}>
          {title}
          {/* Accès clavier : un bouton sans texte (h3.textContent reste le titre) étendu sur la zone texte. */}
          {onClick && <button type="button" aria-label={title} className="absolute inset-0 outline-none" />}
        </h3>
        {/* neutral-900/90 partout, extrait de la modale compris : le neutral-800/88 d'origine fait 4,45:1 sur SR (lib/contrast.test.ts). */}
        {text && <p className={`${excerpt ? 'text-[10px] line-clamp-[10]' : s.p} text-neutral-900/90`}>{text}</p>}
        <div className="mt-auto">
          {/* Au-dessus du bouton du h3 (z-10) ; boîte de 44 × 44 px au moins (D:751) qui monte de 28 px sur la description, pastille en bas,
              à sa place. stopPropagation : la racine ouvrirait la modale. */}
          {friendOwner && (
            <Link
              href={`/profile/${encodeURIComponent(friendOwner)}`}
              aria-label={`Profil de ${friendOwner}`}
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 inline-flex min-h-11 min-w-11 max-w-full items-end -mt-7"
            >
              <span className="mb-1 inline-flex max-w-full items-center gap-1 rounded-full bg-sky-300/65 px-1.5 py-0.5 text-[9px] font-semibold text-black">
                <Users className="size-3 shrink-0" />
                <span className="truncate">{friendOwner}</span>
              </span>
            </Link>
          )}
          {/* svg puis span.font-bold, côte à côte (R§6.4) : l'étiquette sr-only passe avant l'icône. */}
          <div className={`flex w-full items-center justify-between border-t border-black/20 pt-1 py-1 ${s.stats}`}>
            <span className="inline-flex items-center gap-1">
              <span className="sr-only">ATK</span>
              <Swords className={`${s.icon} text-red-800`} />
              <span className="font-bold text-black/90 tabular-nums">{formatInt(card.atk ?? 0)}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="sr-only">DEF</span>
              <Shield className={`${s.icon} text-blue-800`} />
              <span className="font-bold text-black/90 tabular-nums">{formatInt(card.def ?? 0)}</span>
            </span>
          </div>
        </div>
      </div>
      {r.code === 'L' && (
        <div className="absolute inset-0 z-40 overflow-hidden pointer-events-none">
          <div className="legendary-shimmer-sheen" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}

// Sans image : l'emblème de notre marque (jamais le logo d'origine), à 70 % comme l'original.
function Emblem() {
  return (
    <div className="relative flex h-full w-full items-center justify-center p-1.5">
      <div className="relative aspect-[4/3] w-[52%] min-w-[4rem] max-w-[9rem]">
        <svg role="img" aria-label={brand.name} viewBox="0 0 120 90" className="size-full text-black opacity-70">
          <rect x="1.5" y="1.5" width="117" height="87" rx="14" fill="white" fillOpacity="0.45" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
          <text
            x="60"
            y="46"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.min(28, 170 / brand.name.length)}
            fontWeight="800"
            fill="currentColor"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            {brand.prefix && <tspan fill="var(--color-accent-foreground)">{brand.prefix}</tspan>}
            {brand.rest}
          </text>
        </svg>
      </div>
    </div>
  )
}
