'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { BattleRules } from '@/components/battle/BattleRules'
import { battleLine, isOpen, type Battle, type BattleList } from '@/components/battle/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { link, primary } from '@/components/ui/button'
import { HelpDialog } from '@/components/ui/HelpDialog'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { ReadError, Section } from '@/components/ui/Section'
import { tabKey } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import { api, calendarTz, UNSURE, unsure, userMessage } from '@/lib/api'
import { challengeFriend } from '@/lib/challenge'
import { formatInt, formatShortDate, formatTime } from '@/lib/format'
import { usePoll } from '@/lib/poll'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/battle')
const TABS = ['open', 'closed'] as const
type Tab = (typeof TABS)[number]
const LABELS: Record<Tab, string> = { open: 'En cours', closed: 'Terminées' }
const EMPTY: Record<Tab, string> = { open: 'Aucune bataille en cours.', closed: 'Aucune bataille terminée.' }
const LINE: Partial<Record<string, string>> = { Victoire: 'text-green-400', Défaite: 'text-red-400', Annulée: 'text-[var(--color-foreground)]/60' }
// Batailles d'un panneau : ses liens.
const ROW = ':scope > a'

type Player = { id: string; username: string }
type Friendship = { status: 'pending' | 'accepted'; requester_id: string; requester: Player; addressee: Player }

// /battle : quota du jour, « Défier un ami », batailles en cours et terminées, règles lues dans la config (M5a-16). Deux lectures
// indépendantes, chacune avec son échec : /api/battles (au poll) et /api/friends avec la session du navigateur (P16). Aucun id fixe.
export function BattleClient() {
  const id = useId()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('open')
  const [list, setList] = useState<BattleList | null>(null)
  const [listFailed, setListFailed] = useState(false)
  // Joueur de la session, lu avec les amis : undefined tant qu'il n'est pas lu, null sans session.
  const [me, setMe] = useState<string | null>()
  const [friends, setFriends] = useState<Player[] | null>(null)
  const [friendsFailed, setFriendsFailed] = useState(false)
  // Un défi à la fois : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState(false)
  // Échec du dernier défi (role=alert de « Défier un ami ») : un refus reste jusqu'au défi suivant (friend null) ; une issue inconnue, tant
  // que la ligne de cet ami garde l'état pris au départ (bataille ouverte ou non).
  const [error, setError] = useState<{ text: string; friend: string | null; open: boolean } | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  // Générations : une lecture partie avant la dernière (poll lent, réaffichage) ne remet pas l'ancien état.
  const listGen = useRef(0)
  const friendsGen = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const friendsTitle = useRef<HTMLHeadingElement>(null)
  // Cibles du focus quand l'élément focalisé disparaît, armées par une lecture réussie ou par « Réessayer », consommées après le rendu
  // seulement si le focus est tombé sur body : rang de la bataille focalisée (ou l'onglet), ami de la ligne focalisée (ou le titre).
  const listFocus = useRef<number | 'tab' | null>(null)
  const rowFocus = useRef<string | null>(null)

  // Élément focalisé quand une lecture s'applique : sa ligne d'ami, ou, pour une lecture des batailles, son rang dans le panneau.
  const capture = (inPanel: boolean) => {
    const el = document.activeElement
    if (!el || !root.current?.contains(el)) return
    const row = el.closest<HTMLElement>('[data-friend]')
    if (row) rowFocus.current = row.dataset.friend!
    else if (inPanel && panel.current?.contains(el)) listFocus.current = Math.max(0, [...panel.current.querySelectorAll(ROW)].indexOf(el))
  }

  // Lue à chaque affichage (Activity compris) et toutes les 15 s, onglet visible, dans le fuseau du navigateur (sans l'en-tête, le quota
  // suivrait Paris). Un 2xx illisible ou incomplet est une lecture en échec ; un échec garde la liste affichée.
  const readBattles = () => {
    const g = ++listGen.current
    return api<BattleList | null>('/api/battles', { headers: calendarTz() }).catch(() => null).then((r) => {
      if (g !== listGen.current) return
      if (!r || !Array.isArray(r.battles) || !r.challenge_quota || !r.rules) return setListFailed(true)
      capture(true)
      // Bataille ouverte avec un ami : sa ligne montre « Voir la bataille », la relance est refusée ; la clé de son défi est oubliée.
      for (const b of r.battles.filter(isOpen)) for (const u of [b.challenger_id, b.opponent_id]) keys.current.delete(`challenge:${u}`)
      setList(r)
      setListFailed(false)
    })
  }

  // À chaque affichage et après chaque défi ; sans session, ou un 2xx illisible ou sans friendships : une lecture en échec.
  const readFriends = () => {
    const g = ++friendsGen.current
    return Promise.all([
      api<{ friendships: Friendship[] } | null>('/api/friends').catch(() => null),
      createBrowserSupabase().auth.getSession().then(({ data }) => data.session?.user.id ?? null, () => null),
    ]).then(([r, uid]) => {
      if (g !== friendsGen.current) return
      setMe(uid)
      if (!uid || !Array.isArray(r?.friendships)) return setFriendsFailed(true)
      capture(false)
      setFriends(r.friendships.filter((f) => f.status === 'accepted').map((f) => (f.requester_id === uid ? f.addressee : f.requester)))
      setFriendsFailed(false)
    })
  }

  const onShow = useEffectEvent(() => {
    void readBattles()
    void readFriends()
  })
  useEffect(() => onShow(), [])
  usePoll(readBattles, 15_000)

  const shown = list && me ? { list, me } : null
  const listBad = listFailed || me === null
  const quota = list?.challenge_quota
  const full = !!quota && quota.used >= quota.limit
  const openWith = (friend: string) => list?.battles.find((b) => isOpen(b) && (b.challenger_id === friend || b.opponent_id === friend))

  // « Réessayer » des batailles → l'onglet sélectionné, sinon le h1 ; une bataille sortie de l'onglet sous le focus → celle de même rang,
  // sinon l'état vide.
  useEffect(() => {
    const f = listFocus.current
    // En chargement (« Réessayer » vient d'être pressé) : la cible attend la lecture.
    if (f === null || (!(list && me) && !listFailed && me !== null)) return
    listFocus.current = null
    if (document.activeElement !== document.body) return
    if (f === 'tab') return void (root.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]') ?? heading.current)?.focus()
    const rows = panel.current?.querySelectorAll<HTMLElement>(ROW)
    ;(rows?.[Math.min(f, rows.length - 1)] ?? panel.current?.querySelector<HTMLElement>('[tabindex="-1"]'))?.focus()
  }, [list, me, listFailed])

  // « Réessayer » des amis → le titre de « Défier un ami » ; « Défier » remplacé par « Voir la bataille » (ou l'inverse) sous le focus →
  // le contrôle de la même ligne, sinon le titre.
  useEffect(() => {
    const f = rowFocus.current
    if (f === null || (!friends && !friendsFailed)) return
    rowFocus.current = null
    if (document.activeElement !== document.body) return
    ;((f === 'title' ? null : root.current?.querySelector<HTMLElement>(`[data-friend="${f}"] > :last-child`)) ?? friendsTitle.current)?.focus()
  }, [friends, friendsFailed, list])

  async function challenge(f: Player) {
    if (inflight.current || full) return
    // Avant tout await : l'incertitude s'attache à la ligne telle qu'elle était au départ, jamais à une relecture faite pendant la requête.
    const open = !!openWith(f.id)
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await challengeFriend(keys.current, f.id)
      router.push(`/battle/${r.id}`)
      toast(r.existing ? `Une bataille est déjà en cours avec ${f.username}.` : `Défi envoyé à ${f.username}.`)
    } catch (e) {
      // Issue inconnue : clé gardée (apiOnce), la relance rejoue ; l'alerte tombe quand la relecture change la ligne. Jamais de toast.
      setError(unsure(e) ? { text: userMessage(e, UNSURE), friend: f.id, open } : { text: userMessage(e, 'L\'action n\'a pas abouti.'), friend: null, open })
      void readBattles()
    } finally {
      inflight.current = false
      setBusy(false)
    }
    void readFriends()
  }

  function retryBattles() {
    listFocus.current = 'tab'
    setListFailed(false)
    void readBattles()
  }

  function retryFriends() {
    rowFocus.current = 'title'
    setFriendsFailed(false)
    void readFriends()
  }

  const rows = shown?.list.battles.filter((b) => isOpen(b) === (tab === 'open'))
  const other = (b: Battle) => (b.challenger_id === me ? b.opponent : b.challenger)
  const ready = (list || listFailed) && (friends || friendsFailed)
  return (
    <div ref={root} data-ready={ready ? '' : undefined} className="space-y-6">
      <PageHeader ref={heading} title={entry.title} icon={entry.icon}>
        {list && (
          <HelpDialog>
            <BattleRules rules={list.rules} />
          </HelpDialog>
        )}
      </PageHeader>

      {shown && (
        <div className="card-frame flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 text-sm">
          <p className="font-semibold">{`${formatInt(shown.list.challenge_quota.used)} / ${formatInt(shown.list.challenge_quota.limit)} défis aujourd'hui`}</p>
          {full && <p className="text-[var(--color-foreground)]/70">{`Nouveaux défis à ${formatTime(shown.list.challenge_quota.resets_at)}`}</p>}
        </div>
      )}

      <Section id={`${id}-friends`} title="Défier un ami" ref={friendsTitle}>
        {friends ? (
          friends.length ? (
            <>
              {quota && full && <p id={`${id}-full`} className="text-sm text-[var(--color-foreground)]/70">{`Tu as utilisé tes ${formatInt(quota.limit)} défis du jour.`}</p>}
              <ul className="divide-y divide-[var(--color-border)]">
                {friends.map((f) => {
                  const b = openWith(f.id)
                  // Les contrôles de la ligne sont décrits par le pseudo : leur nom reste le texte visible.
                  const who = `${id}-who-${f.id}`
                  return (
                    <li key={f.id} data-friend={f.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
                      <Link id={who} href={`/profile/${encodeURIComponent(f.username)}`} className={`${link} min-w-0 wrap-anywhere`}>{f.username}</Link>
                      {b ? (
                        <Link href={`/battle/${b.id}`} aria-describedby={who} className={link}>Voir la bataille</Link>
                      ) : (
                        <button
                          type="button"
                          aria-disabled={busy || full || undefined}
                          aria-describedby={full ? `${who} ${id}-full` : who}
                          onClick={() => void challenge(f)}
                          className={primary}
                        >
                          Défier
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <div className="space-y-1 text-sm">
              <p>Aucun ami à défier.</p>
              <p>Ajoute des amis depuis la page <Link href="/friends" className={link}>Amis</Link>.</p>
            </div>
          )
        ) : friendsFailed ? (
          <ReadError onRetry={retryFriends}>Tes amis n&apos;ont pas pu être chargés.</ReadError>
        ) : (
          <Loading label="Chargement des amis" />
        )}
        {error && (error.friend === null || !!openWith(error.friend) === error.open) && (
          <p role="alert" className="text-sm font-medium text-red-400">{error.text}</p>
        )}
      </Section>

      {shown && rows ? (
        <div className="space-y-3">
          {/* Une ligne, défilée dans son propre conteneur sur téléphone (jamais la page) ; anneau de focus intérieur : overflow le couperait. */}
          <div role="tablist" aria-label="Vues des batailles" className="flex flex-nowrap gap-x-1 overflow-x-auto border-b border-[var(--color-border)]">
            {TABS.map((t) => (
              <button
                key={t}
                id={`${id}-tab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls={`${id}-panel`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={(e) => tabKey(e, TABS, tab, id, setTab)}
                className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-4 text-sm font-semibold transition-colors focus-visible:-outline-offset-2 ${tab === t ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-b-2 border-transparent text-[var(--color-foreground)]/70 hover:text-[var(--color-foreground)]'}`}
              >
                {LABELS[t]}
              </button>
            ))}
          </div>
          <div ref={panel} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="space-y-3">
            {rows.length ? (
              rows.map((b) => {
                const line = battleLine(b, shown.me)
                return (
                  <Link
                    key={b.id}
                    href={`/battle/${b.id}`}
                    className="card-frame flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-[var(--color-surface-light)]"
                  >
                    <span className="min-w-0 font-semibold wrap-anywhere">{`Contre ${other(b).username}`}</span>
                    <time dateTime={b.created_at} className="text-sm text-[var(--color-foreground)]/70">{formatShortDate(b.created_at)}</time>
                    <span className={`ml-auto text-sm font-medium ${LINE[line] ?? ''}`}>{line}</span>
                  </Link>
                )
              })
            ) : (
              <p tabIndex={-1} className="card-frame p-6 text-center text-sm outline-none">{EMPTY[tab]}</p>
            )}
          </div>
        </div>
      ) : listBad ? (
        <LoadError onRetry={retryBattles} text="Tes batailles n'ont pas pu être chargées." />
      ) : (
        <Loading label="Chargement des batailles" />
      )}
    </div>
  )
}
