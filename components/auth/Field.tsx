import type { ComponentProps } from 'react'

// Champ requis, nommé comme son id ; l'erreur éventuelle est annoncée et reliée au champ.
export function Field({ id, label, error, ...input }: { id: string; label: string; error?: string | null } & ComponentProps<'input'>) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={id}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="rounded-xl border border-foreground/50 bg-surface-light px-4 py-3"
        {...input}
      />
      {error && <FormError id={`${id}-error`}>{error}</FormError>}
    </div>
  )
}

export function FormError({ id, children }: { id?: string; children: string }) {
  return (
    <p id={id} role="alert" className="text-sm text-red-300">
      {children}
    </p>
  )
}

export const linkClass = 'inline-flex min-h-11 items-center rounded-xl text-sm font-medium text-accent hover:text-accent-light'
