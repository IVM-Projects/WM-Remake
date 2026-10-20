import { CheckSquare } from 'lucide-react'
import { RarityChips } from '@/components/ui/RarityChips'
import type { RarityCode } from '@/lib/rarity'

export type TagCount = { id: string; name: string; color: string | null; count: number }

// Ordre du relevé (R§2.2) ; « Rareté » par défaut. Valeurs de `sort` de /api/my-collection.
const SORTS = [['obtained_at', 'Date d\'ajout'], ['name', 'Nom'], ['rarity', 'Rareté'], ['atk', 'ATK'], ['def', 'DEF'], ['starred', 'Favoris']] as const

type Props = {
  text: string
  onText: (text: string) => void
  tagId: string
  onTag: (tagId: string) => void
  tags: TagCount[]
  sort: string
  onSort: (sort: string) => void
  rarity: RarityCode[]
  onRarity: (rarity: RarityCode[]) => void
  selecting: boolean
  onSelecting: (on: boolean) => void
}

const control = 'min-h-11 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 text-sm'

// Recherche (autofocus, R§2.2), étiquettes avec leur nombre de copies, tri, raretés et mode sélection.
export function CollectionToolbar({ text, onText, tagId, onTag, tags, sort, onSort, rarity, onRarity, selecting, onSelecting }: Props) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          // Comme l'original (R§2.2) : la recherche est l'entrée de la page.
          autoFocus
          aria-label="Rechercher par titre ou catégorie"
          placeholder="Rechercher par titre ou catégorie..."
          value={text}
          onChange={(e) => onText(e.target.value)}
          className={`${control} w-full min-w-0 py-2.5 placeholder:text-[var(--color-foreground)]/60 sm:w-auto sm:flex-1 sm:basis-64`}
        />
        <select aria-label="Filtrer par étiquette" value={tagId} onChange={(e) => onTag(e.target.value)} className={`${control} min-w-0 max-w-full`}>
          <option value="">Toutes les étiquettes</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.count})</option>)}
        </select>
        <select aria-label="Trier les cartes" value={sort} onChange={(e) => onSort(e.target.value)} className={control}>
          {SORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <button
          type="button"
          aria-pressed={selecting}
          onClick={() => onSelecting(!selecting)}
          className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors ${selecting ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-light)]' : 'border border-[var(--color-foreground)]/40 hover:bg-[var(--color-surface-light)]'}`}
        >
          <CheckSquare className="size-4" />
          Sélectionner
        </button>
      </div>
      <RarityChips value={rarity} onChange={onRarity} />
    </div>
  )
}
