import Link from 'next/link'
import { ghost, link, primary } from '@/components/ui/button'
import { ProBadge } from '@/components/ui/ProBadge'
import { WCoin } from '@/components/ui/WCoin'
import { formatInt } from '@/lib/format'
import { formatPrice, SHOP, type ShopItem, type ShopState } from '@/lib/shop'

type Props = {
  state: ShopState
  busy: ShopItem | 'portal' | null
  error: string | null
  onBuy: (item: ShopItem) => void
  onPortal: () => void
}

// Les deux offres de la boutique (G21), présentation pure : les avantages Pro viennent des seules règles de wm.config (D:629), jamais d'un texte en dur.
export function ShopOffers({ state, busy, error, onBuy, onPortal }: Props) {
  const { rules, me, maintenance } = state
  const price = formatPrice(SHOP.pro_monthly.cents)
  const wbPrice = formatPrice(SHOP.wb_2500.cents)
  const wb = formatInt(rules.wb_2500)
  const perks = [
    `Un paquet toutes les ${formatInt(rules.pack_period_s.pro / 60)} minutes au lieu de ${formatInt(rules.pack_period_s.free / 60)}`,
    `Un paquet Pro de ${formatInt(rules.pro_daily_size)} cartes chaque jour, sans aucune commune`,
    `${formatInt(rules.max_concurrent_auctions.pro)} ventes en même temps au lieu de ${formatInt(rules.max_concurrent_auctions.free)}`,
    `L'historique détaillé des ventes sur ${formatInt(rules.sales_detail_days)} jours`,
    `${formatInt(rules.battle_quota.pro)} défis de bataille par jour au lieu de ${formatInt(rules.battle_quota.free)}`,
  ]
  // Un abonnement non terminal (même impayé) se gère au Portail : un second Checkout serait refusé (G9).
  const managed = me.subscription !== null && !['canceled', 'incomplete_expired'].includes(me.subscription.status)
  const locked = busy !== null || maintenance
  const buy = (item: ShopItem) => () => { if (!locked) onBuy(item) }

  return (
    <div className="mt-5 space-y-4">
      {maintenance && <p role="status" className="rounded-xl border border-amber-400/40 px-3 py-2 text-sm">La boutique est fermée pendant la maintenance.</p>}
      <section className="space-y-3 rounded-xl border border-violet-400/40 bg-[var(--color-surface-light)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-bold">Abonnement Pro</h3>
          <ProBadge />
        </div>
        <p className="text-sm font-semibold">{price} par mois</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-foreground)]/80">
          {perks.map((p) => <li key={p}>{p}</li>)}
        </ul>
        {managed ? (
          <>
            {me.is_pro && <p className="text-sm font-semibold">Tu es membre Pro.</p>}
            <button type="button" aria-disabled={busy !== null || undefined} onClick={() => { if (busy === null) onPortal() }} className={ghost}>
              Gérer mon abonnement
            </button>
          </>
        ) : me.is_vip ? (
          <p className="text-sm font-semibold">Avantages Pro accordés par l&apos;équipe.</p>
        ) : (
          <button type="button" aria-label={`S'abonner à Pro pour ${price} par mois`} aria-disabled={locked || undefined} onClick={buy('pro_monthly')} className={primary}>
            S&apos;abonner
          </button>
        )}
      </section>
      <section className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-light)] p-4">
        <h3 className="inline-flex items-center gap-2 text-lg font-bold">
          <WCoin className="size-5 text-amber-300" />
          {wb} wikibidous
        </h3>
        <p className="text-sm font-semibold">{wbPrice}, paiement unique</p>
        <button type="button" aria-label={`Acheter ${wb} wikibidous pour ${wbPrice}`} aria-disabled={locked || undefined} onClick={buy('wb_2500')} className={primary}>
          Acheter
        </button>
      </section>
      {busy !== null && <p role="status" className="text-sm font-medium">Redirection vers le paiement…</p>}
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      <div className="space-y-1 text-sm text-foreground/70">
        <p>Achat de contenu numérique fourni tout de suite : au paiement, tu renonces à ton droit de rétractation.</p>
        {/* Nouvel onglet : la boutique et son achat en cours restent ouverts. */}
        <Link href="/terms" target="_blank" rel="noopener noreferrer" className={link}>
          Voir les conditions<span className="sr-only"> (nouvel onglet)</span>
        </Link>
        <p>Paiement sécurisé par Stripe. Mode test : aucune carte réelle n&apos;est débitée.</p>
      </div>
    </div>
  )
}
