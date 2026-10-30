'use client'

import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Thread } from '@/components/dms/Thread'
import { GuildBoard } from '@/components/guild/GuildBoard'
import { GuildHelp } from '@/components/guild/GuildHelp'
import { ChefPill, GuildMembers } from '@/components/guild/GuildMembers'
import { NoGuild } from '@/components/guild/NoGuild'
import { isGuildState, isNoGuild, keepOnly, membersLabel, type GuildState } from '@/components/guild/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { danger, ghost } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { tabKey } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toast'
import { api, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { unreadStore } from '@/lib/notifications'

const entry = navEntry('/guild')
const TABS = ['chat', 'help', 'members', 'board'] as const
type Tab = (typeof TABS)[number]
const LABELS: Record<Tab, string> = { chat: 'Chat', help: 'Entraide', members: 'Membres', board: 'Classement' }

// /guild : sans guilde (invitations, création) ou membre (en-tête, onglets). Relue à chaque affichage et à chaque version de la cloche
// (une invitation ou une exclusion y arrive) ; l'état vient de /api/guilds, l'identité du joueur de son adhésion.
export function GuildClient() {
  const id = useId()
  const [state, setState] = useState<GuildState | null>(null)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const stateRef = useRef<GuildState | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  // Générations : une lecture partie avant la dernière appliquée est jetée.
  const gen = useRef(0)
  const applied = useRef(0)
  // Cible du focus après le rendu qui suit : le h1 (départ, « Réessayer ») ou le nom de la guilde (rejoint, créée, chef nommé).
  const focusTo = useRef<'h1' | 'h2' | null>(null)
  const h1 = useRef<HTMLHeadingElement>(null)
  const h2 = useRef<HTMLHeadingElement>(null)
  const root = useRef<HTMLDivElement>(null)

  const apply = (r: GuildState) => {
    const prev = stateRef.current
    if (prev?.guild && !r.guild) {
      toast('Tu ne fais plus partie de cette guilde.')
      // Le bouton qui avait le focus disparaît avec la vue membre : le h1 le reprend (l'effet [state] vérifie que le focus est sur body).
      focusTo.current ??= 'h1'
    }
    if (!r.guild) {
      // Plus de guilde : la clé et la modale d'un départ incertain ne valent plus pour la prochaine adhésion.
      keys.current.delete('leave')
      setLeaving(false)
      setLeaveError(null)
    }
    stateRef.current = r
    setState(r)
    setFailed(false)
  }
  // Un échec garde l'état affiché ; sans état, il montre « Réessayer ».
  const read = (): Promise<void> => {
    const g = ++gen.current
    return api<unknown>('/api/guilds').catch(() => null).then((r) => {
      if (g < applied.current) return
      applied.current = g
      if (isGuildState(r)) apply(r)
      else setFailed(true)
    })
  }
  const version = useSyncExternalStore(unreadStore().subscribe, unreadStore().getVersion, () => 0)
  const onShow = useEffectEvent(() => void read())
  useEffect(() => onShow(), [version])

  useEffect(() => {
    const t = focusTo.current
    const el = t === 'h1' ? h1.current : t === 'h2' ? h2.current : null
    if (!el) return
    focusTo.current = null
    // Un focus posé ailleurs (cloche, lien) n'est pas volé : seul body signale un contrôle disparu.
    if (document.activeElement === document.body) el.focus()
  }, [state])

  // État rendu par une écriture (guilde rejointe, créée, quittée) : il prime sur toute lecture partie avant.
  const joined = (s: GuildState) => {
    applied.current = ++gen.current
    apply(s)
  }
  const retry = () => {
    focusTo.current = 'h1'
    setFailed(false)
    void read()
  }

  const focusTab = () => root.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus()
  const member = state?.guild && state.membership ? { guild: state.guild, membership: state.membership } : null
  const blocked = member?.membership.role === 'leader' && state!.member_count > 1

  async function leave() {
    if (inflight.current || blocked) return
    inflight.current = true
    setBusy(true)
    setLeaveError(null)
    keepOnly(keys.current, 'leave')
    try {
      await apiOnce(keys.current, 'leave', '/api/guilds/leave', { method: 'POST' })
      toast('Tu as quitté la guilde.')
      // État sans guilde posé tout de suite, les lectures parties avant jetées : une relecture qui échoue ou se perd ne ramène ni la vue
      // membre, ni « Tu ne fais plus partie… » (l'état d'avant n'a plus de guilde). La relecture suivante complète les invitations.
      focusTo.current = 'h1'
      const gone: GuildState = { guild: null, membership: null, member_count: 0, invites: state?.invites ?? [] }
      // stateRef d'abord : apply() ne voit pas un retrait subi, le toast « Tu as quitté… » suffit.
      stateRef.current = gone
      joined(gone)
      setLeaving(false)
      await read()
    } catch (e) {
      if (isNoGuild(e)) return void read()
      setLeaveError(unsure(e) ? UNSURE : userMessage(e, 'L\'action n\'a pas abouti.'))
      void read()
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const note = !member ? '' : blocked ? 'Transmets d\'abord ton rôle de chef à un membre.'
    : state!.member_count <= 1 ? 'Tu es le dernier membre : la guilde sera dissoute.' : 'Tu pourras revenir sur une nouvelle invitation.'

  return (
    <div ref={root} data-ready={state || failed ? '' : undefined} className="space-y-6">
      <PageHeader ref={h1} title={entry.title} icon={entry.icon} />

      {!state ? (
        failed ? <LoadError onRetry={retry} /> : <Loading label="Chargement de la guilde" />
      ) : !member ? (
        <NoGuild invites={state.invites} onState={(s) => { focusTo.current = 'h2'; joined(s) }} onRead={read} />
      ) : (
        <>
          <div className="card-frame flex flex-wrap items-start justify-between gap-4 p-6">
            <div className="min-w-0 space-y-2">
              <h2 ref={h2} tabIndex={-1} className="text-xl font-bold outline-none wrap-anywhere">{member.guild.name}</h2>
              {member.guild.description && <p className="text-sm whitespace-pre-wrap wrap-anywhere">{member.guild.description}</p>}
              <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-foreground)]/70">
                <span>{membersLabel(state.member_count)}</span>
                {member.membership.role === 'leader' && <ChefPill />}
              </p>
            </div>
            <button type="button" aria-haspopup="dialog" onClick={() => setLeaving(true)} className={ghost}>Quitter la guilde</button>
          </div>

          <div className="space-y-3">
            {/* Une ligne, défilée dans son propre conteneur sur téléphone (jamais la page) ; anneau de focus intérieur : overflow le couperait. */}
            <div role="tablist" aria-label="Vues de la guilde" className="flex flex-nowrap gap-x-1 overflow-x-auto border-b border-[var(--color-border)]">
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
            <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
              {tab === 'chat' && (
                <Thread channel={{ kind: 'guild' }} me={member.membership.user_id} onSent={() => {}} onSettled={() => {}} onGone={() => void read()} />
              )}
              {tab === 'help' && <GuildHelp onLost={() => void read()} onTab={focusTab} />}
              {tab === 'members' && (
                <GuildMembers
                  me={member.membership.user_id}
                  isLeader={member.membership.role === 'leader'}
                  onLost={() => void read()}
                  onChanged={() => void read()}
                  onHeading={() => h2.current?.focus()}
                  onTab={focusTab}
                />
              )}
              {tab === 'board' && <GuildBoard onTab={focusTab} />}
            </div>
          </div>

          {leaving && (
            <Modal onClose={() => { if (!inflight.current) setLeaving(false) }} labelledBy={`${id}-leave`} className="card-frame relative w-full max-w-md animate-fade-in-up space-y-4 p-6">
              <h2 id={`${id}-leave`} className="text-xl font-bold wrap-anywhere">{`Quitter ${member.guild.name} ?`}</h2>
              <p id={`${id}-leave-note`} className="text-sm">{note}</p>
              {leaveError && <p role="alert" className="text-sm font-medium text-red-400">{leaveError}</p>}
              <div className="flex flex-wrap justify-end gap-3">
                <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) setLeaving(false) }} className={ghost}>Annuler</button>
                <button
                  type="button"
                  aria-disabled={busy || blocked || undefined}
                  aria-describedby={blocked ? `${id}-leave-note` : undefined}
                  onClick={() => void leave()}
                  className={danger}
                >
                  Quitter
                </button>
              </div>
            </Modal>
          )}
        </>
      )}
    </div>
  )
}
