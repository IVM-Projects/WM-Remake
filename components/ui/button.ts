// Bouton secondaire bordé (contour blanc cassé à 40 %, ≥ 3:1) ; inactif en aria-disabled : texte /60, contour décoratif.
// Sans gap ni alignement : chaque appelant garde le sien.
export const ghost = 'inline-flex min-h-11 items-center rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)] aria-disabled:cursor-not-allowed aria-disabled:border-[var(--color-border)] aria-disabled:text-[var(--color-foreground)]/60 aria-disabled:hover:bg-transparent'
// Bouton principal (accent) ; inactif en aria-disabled pendant sa requête : curseur d'attente, opacité 80 %.
export const primary = 'inline-flex min-h-11 items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-progress aria-disabled:opacity-80'
// Lien d'action en accent clair, souligné au survol ; cible de 44 px.
export const link = 'inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-accent-light)] underline-offset-2 hover:underline'
