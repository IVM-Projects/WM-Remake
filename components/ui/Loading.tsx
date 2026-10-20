// Chargement du R§6.3 (spinner du shell) ; `label` est dit aux lecteurs d'écran.
export function Loading({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center py-16" role="status">
      <div className="w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
      <span className="sr-only">{label}</span>
    </div>
  )
}
