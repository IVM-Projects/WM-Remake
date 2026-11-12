import { Sparkles } from 'lucide-react'

// Pastille « PRO » (violet) : onglet Marché de la carte (active = onglet choisi), en-tête et boutique (inactive).
export function ProBadge({ active = false }: { active?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${active ? 'bg-[var(--color-accent-foreground)] text-violet-300' : 'bg-violet-500/20 text-violet-300'}`}
    >
      <Sparkles className="size-3" />
      PRO
    </span>
  )
}
