'use client'

import { useActionState } from 'react'
import { enterGate } from './actions'

export function GateForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(enterGate, null)
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="gate-password" className="text-sm font-medium">
        Mot de passe de la démo
      </label>
      <input
        id="gate-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        aria-describedby={error ? 'gate-error' : undefined}
        className="rounded-xl border border-foreground/50 bg-surface-light px-4 py-3"
      />
      {error && (
        <p id="gate-error" role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-light disabled:opacity-45"
      >
        Entrer
      </button>
    </form>
  )
}
