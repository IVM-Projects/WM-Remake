import { formatInt, wikibidous } from '@/lib/format'
import type { Rules } from './types'

// Règles de « Comment ça marche ? » sur /battle, chaque valeur lue dans wm.config (M5a-16) ; aucun point de guilde avant le M5b (M5a-2).
export function BattleRules({ rules: r }: { rules: Rules }) {
  const items = [
    `Défie un ami : il a ${formatInt(r.invite_ttl_h)} h pour accepter.`,
    'Chaque joueur choisit 3 cartes différentes ; tes PV de départ sont la somme de leurs DEF.',
    'Celui qui défie attaque en premier, puis chacun son tour : chaque carte attaque une seule fois.',
    `À chaque attaque, le défenseur répond à ${formatInt(r.questions)} questions sur l'article de la carte qui attaque, sans minuteur.`,
    'Dégâts : ATK × mauvaises réponses ÷ nombre de questions, arrondis ; tout juste, aucun dégât.',
    'Victoire par KO ; sinon, la plus grande part de PV restants, puis le plus de PV, puis le défenseur du dernier tour.',
    `Pendant la partie, sans action pendant ${formatInt(r.idle_loss_h)} h, le joueur qui doit jouer perd ; pendant le choix des cartes, la bataille est annulée.`,
    `${formatInt(r.quota_free)} défis par jour, ${formatInt(r.quota_pro)} avec Pro, selon ton fuseau horaire.`,
    `Gagnant : +${formatInt(r.reward_win)} ${wikibidous(r.reward_win)} ; perdant : +${formatInt(r.reward_loss)} ${wikibidous(r.reward_loss)}.`,
  ]
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((t) => <li key={t}>{t}</li>)}
    </ul>
  )
}
