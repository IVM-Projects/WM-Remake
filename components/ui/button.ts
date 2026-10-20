// Bouton secondaire bordé (contour blanc cassé à 40 %, ≥ 3:1) ; inactif en aria-disabled : texte /60, contour décoratif.
// Sans gap ni alignement : chaque appelant garde le sien.
export const ghost = 'inline-flex min-h-11 items-center rounded-xl border border-[var(--color-foreground)]/40 px-4 text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)] aria-disabled:cursor-not-allowed aria-disabled:border-[var(--color-border)] aria-disabled:text-[var(--color-foreground)]/60 aria-disabled:hover:bg-transparent'
