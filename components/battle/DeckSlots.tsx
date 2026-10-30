'use client'

import { Plus } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Card, SIZES } from '@/components/card/Card'
import { faceOf, type OwnedItem } from '@/components/card/CardModal'
import { CardPicker } from '@/components/profile/CardPicker'
import { ghost, link, primary } from '@/components/ui/button'
import { formatInt } from '@/lib/format'

const hint = 'text-sm text-[var(--color-foreground)]/70'

// Choix des 3 cartes (D:528, M5a-11), sans requête jusqu'à « Valider mon deck » : 3 emplacements comme la vitrine de /profile, remplis par
// le sélecteur en mode deck. État local : le poll de l'arène ne le touche pas. Doublon : deux copies de la même carte (card_id).
export function DeckSlots({ busy, onSubmit }: { busy: boolean; onSubmit: (copies: string[]) => void }) {
  const id = useId()
  const [slots, setSlots] = useState<(OwnedItem | null)[]>([null, null, null])
  const [picker, setPicker] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)
  // Contrôle disparu sous le focus (emplacement rempli, « Retirer ») : le premier bouton du même emplacement, après le rendu, si le focus est
  // tombé sur body (modèle profile-editor.tsx). La cible attend le rendu qui montre l'emplacement attendu, sélecteur fermé : l'effet d'un
  // rendu précédent (poll), vidé juste avant, ne la prend pas.
  const refocus = useRef<{ n: number; filled: boolean } | null>(null)
  // Page quittée puis gardée par Activity : on ne la retrouve pas avec le sélecteur ouvert.
  useLayoutEffect(() => () => setPicker(null), [])
  useEffect(() => {
    const r = refocus.current
    if (!r || picker !== null || !!slots[r.n] !== r.filled) return
    refocus.current = null
    if (document.activeElement === document.body) root.current?.querySelector<HTMLElement>(`[data-slot="${r.n}"] button`)?.focus()
  })

  const put = (n: number, c: OwnedItem | null) => {
    setSlots((s) => s.map((x, i) => (i === n ? c : x)))
    refocus.current = { n, filled: !!c }
  }
  const picked = slots.filter((c): c is OwnedItem => !!c)
  const twice = new Set(picked.map((c) => c.card_id)).size < picked.length
  const off = busy || picked.length < 3 || twice
  const hp = picked.reduce((sum, c) => sum + (faceOf(c).def ?? 0), 0)
  return (
    <section ref={root} aria-labelledby={`${id}-title`} className="space-y-4">
      <h3 id={`${id}-title`} className="text-lg font-bold">Choisis tes 3 cartes</h3>
      <ul className="flex flex-wrap justify-center gap-3 sm:gap-[22px]">
        {slots.map((c, n) => {
          const desc = `${id}-slot-${n}`
          return (
            <li key={n} data-slot={n} className="flex flex-col items-center gap-2">
              {c ? (
                <>
                  <Card card={faceOf(c)} size="grid" count={c.count} isShiny={c.is_shiny} />
                  <span id={desc} className="sr-only">{faceOf(c).wikipedia_title}</span>
                  <div className="flex flex-wrap justify-center gap-2">
                    <button type="button" aria-describedby={desc} aria-disabled={busy || undefined}
                      onClick={() => { if (!busy) setPicker(n) }} className={ghost}>Changer</button>
                    <button type="button" aria-describedby={desc} aria-disabled={busy || undefined}
                      onClick={() => { if (!busy) put(n, null) }} className={ghost}>Retirer</button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  // Premier contrôle utile de l'écran, pour l'arène qui y mène le focus.
                  data-first={n === 0 ? '' : undefined}
                  aria-disabled={busy || undefined}
                  onClick={() => { if (!busy) setPicker(n) }}
                  className={`${SIZES.grid.root} inline-flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--color-foreground)]/40 p-3 text-center text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]`}
                >
                  <Plus aria-hidden="true" className="size-6 text-[var(--color-accent)]" />
                  {`Ajouter une carte à l'emplacement ${n + 1}`}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3">
        <p className={hint}>Il te faut 3 cartes différentes de ta collection.</p>
        <Link href="/pulls" className={link}>Ouvrir des paquets</Link>
      </div>
      <p className="font-semibold">{`PV de ton deck : ${formatInt(hp)}`}</p>
      {twice && <p id={`${id}-twice`} className="text-sm font-medium text-red-400">Choisis 3 cartes différentes.</p>}
      <button
        type="button"
        aria-disabled={off || undefined}
        aria-describedby={twice ? `${id}-twice` : undefined}
        onClick={() => { if (!off) onSubmit(picked.map((c) => c.id)) }}
        className={primary}
      >
        Valider mon deck
      </button>
      {picker !== null && (
        <CardPicker
          mode="deck"
          onPick={async (_, c) => {
            put(picker, c)
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  )
}
