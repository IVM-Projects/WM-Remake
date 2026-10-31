'use client'

import { useId } from 'react'

// Motif obligatoire d'une action du staff (3 à 500 caractères) ; le bouton d'action de la modale reste en aria-disabled sous 3 caractères rognés.
export function ReasonField({ value, onChange, describedBy }: { value: string; onChange: (v: string) => void; describedBy?: string }) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={`${id}-reason`} className="text-sm font-semibold">Motif (obligatoire)</label>
      <textarea
        id={`${id}-reason`}
        value={value}
        minLength={3}
        maxLength={500}
        rows={3}
        aria-describedby={describedBy ? `${describedBy} ${id}-count` : `${id}-count`}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm"
      />
      <p id={`${id}-count`} className="text-xs tabular-nums text-[var(--color-foreground)]/70">{value.length} / 500</p>
    </div>
  )
}
