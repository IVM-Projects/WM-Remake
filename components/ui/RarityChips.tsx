import { RARITY, type RarityCode } from '@/lib/rarity'

type Props = { value: RarityCode[]; onChange: (value: RarityCode[]) => void }

// Pastilles de rareté L…C (R§2.2), style inline d'origine tel quel ([style*="--color-rarity"]), inerte comme la lueur du badge.
// Pressée : cerclée et teintée (bg-current/20, l'intention du « 30 » ; en important, car l'inline inerte l'emporterait).
// Un filtre posé : les autres à 80 %, et non l'opacity-50 d'origine (le rose SR tomberait à 2,5:1 ; lib/contrast.test.ts).
export function RarityChips({ value, onChange }: Props) {
  return (
    <div role="group" aria-label="Filtrer par rareté" className="flex flex-wrap gap-2">
      {RARITY.map((r) => {
        const on = value.includes(r.code)
        return (
          <button
            key={r.code}
            type="button"
            aria-pressed={on}
            title={r.label}
            onClick={() => onChange(on ? value.filter((c) => c !== r.code) : [...value, r.code])}
            className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border px-3 text-xs font-bold transition-opacity ${on ? 'border-current bg-current/20!' : 'border-[var(--color-border)]'} ${value.length && !on ? 'opacity-80' : ''}`}
            style={{ backgroundColor: `var(--color-rarity-${r.css})30`, color: `var(--color-rarity-${r.css})` }}
          >
            {r.code}
          </button>
        )
      })}
    </div>
  )
}
