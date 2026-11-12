'use client'

import { useShop } from '@/components/shop/ShopProvider'
import { ProBadge } from '@/components/ui/ProBadge'
import { WCoin } from '@/components/ui/WCoin'
import { formatInt, wikibidous } from '@/lib/format'

// Solde de l'en-tête (R23, G21) : ouvre la boutique. Le nom accessible est le texte ; la pastille PRO est à côté, hors du bouton.
export function Balance() {
  const { state, failed, openShop } = useShop()
  if (state === null && !failed) return null
  const n = state?.me.balance ?? 0
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        title="Ouvrir la boutique"
        onClick={openShop}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm sm:px-3 font-semibold tabular-nums transition-colors hover:bg-[var(--color-surface-light)]"
      >
        <WCoin className="size-5 text-amber-300" />
        {failed ? (
          // Relu à la prochaine navigation, au retour au premier plan ou à la prochaine défausse.
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Solde indisponible</span>
          </>
        ) : (
          <>
            {formatInt(n)}
            <span className="sr-only"> {wikibidous(n)}</span>
          </>
        )}
      </button>
      {!failed && (state?.me.is_pro || state?.me.is_vip) && <ProBadge />}
    </>
  )
}
