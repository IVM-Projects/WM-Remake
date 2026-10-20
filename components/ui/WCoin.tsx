// Pièce W des wikibidous (tracé du W relevé sur l'original, R§6.5). Décorative : le texte voisin porte le sens.
export function WCoin({ className = 'size-4 text-amber-300' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.15" />
      <path d="M7.5 8.5 9.5 15.5 12 10 14.5 15.5 16.5 8.5" />
    </svg>
  )
}
