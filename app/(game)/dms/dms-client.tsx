'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react'
import { Thread } from '@/components/dms/Thread'
import type { Conversation } from '@/components/dms/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { link } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { api } from '@/lib/api'
import { formatInt, formatShortDate } from '@/lib/format'
import { unreadStore } from '@/lib/notifications'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/dms')

// /dms (M4b-24) : les conversations, et le fil de /dms?with=<id>. Deux colonnes dès md ; dessous, la liste seule ou le fil seul.
export function DmsClient() {
  // Cachée par Activity, la page se rend avec l'adresse de la page visible (app-router.js:442-447) : le fil garde alors son `with`. /dms et
  // /dms?with=… sont une seule instance (la clé de page ignore la recherche, render-tree.js:180-183) : sur /dms, l'adresse fait foi.
  const pathname = usePathname()
  const w = useSearchParams().get('with') || null
  const [peerId, setPeerId] = useState(w)
  // Fil lu (ou en échec) : celui de ce pair, pour data-ready.
  const [settled, setSettled] = useState<string | null>(null)
  if (pathname === '/dms' && w !== peerId) {
    setPeerId(w)
    setSettled(null)
  }
  // Joueur de la session du navigateur (P16) : le fil n'est monté qu'une fois lu.
  const [me, setMe] = useState<string | null>()
  const [list, setList] = useState<Conversation[] | null>(null)
  const [failed, setFailed] = useState(false)
  // Générations : une lecture partie avant la dernière appliquée est jetée.
  const gen = useRef(0)
  const applied = useRef(0)
  const retried = useRef(false)
  const title = useRef<HTMLHeadingElement>(null)
  const conversations = useRef<HTMLUListElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)

  // keep : relecture de fond, dont l'échec laisse la liste affichée. Un 2xx sans `conversations` lisible est une lecture en échec.
  const read = (keep: boolean) => {
    const g = ++gen.current
    return api<{ conversations: Conversation[] } | null>('/api/chat').then((r) => (Array.isArray(r?.conversations) ? r.conversations : null), () => null)
      .then((next) => {
        if (g < applied.current || (!next && keep)) return
        applied.current = g
        if (next) setList(next)
        setFailed(!next)
      })
  }
  // Lue à chaque affichage (Activity compris), à chaque lecture de la cloche (non-lus changés ailleurs, marquage d'un fil), après chaque
  // envoi et sur « Réessayer » ; aucun poll propre (mécanisme de /friends). À froid, la première lecture de la cloche en fait une seconde.
  const version = useSyncExternalStore(unreadStore().subscribe, unreadStore().getVersion, () => 0)
  const onShow = useEffectEvent(() => void read(list !== null))
  useEffect(() => onShow(), [version])
  useEffect(() => {
    void createBrowserSupabase().auth.getSession().then(({ data }) => setMe(data.session?.user.id ?? null), () => setMe(null))
  }, [])

  // « Réessayer » disparu sous le focus (pressé, ou retiré par une relecture de fond réussie) : la première conversation, sinon le h1,
  // ou le « Réessayer » revenu (PF15). Rien si le joueur a mis le focus ailleurs.
  const state = failed ? 'failed' : list ? 'list' : null
  const shown = useRef<typeof state>(null)
  useEffect(() => {
    if (!state || (state === shown.current && !retried.current)) return
    const want = retried.current || shown.current === 'failed'
    shown.current = state
    retried.current = false
    if (!want || document.activeElement !== document.body) return
    ;(state === 'failed' ? retryButton.current : conversations.current?.querySelector('a') ?? title.current)?.focus()
  }, [state])
  // Fil quitté (« ← Conversations ») : le focus tombé sur body va à l'entrée du pair, sinon au h1.
  const left = useRef(peerId)
  useEffect(() => {
    const was = left.current
    left.current = peerId
    if (!was || peerId || document.activeElement !== document.body) return
    const links = [...(conversations.current?.querySelectorAll('a') ?? [])]
    ;(links.find((a) => a.getAttribute('href') === `/dms?with=${was}`) ?? title.current)?.focus()
  }, [peerId])

  function retry() {
    retried.current = true
    setFailed(false)
    void read(false)
  }

  // Sans session lue (me === null), aucun fil ne se monte : la page est rendue telle quelle.
  const ready = (list !== null || failed) && (!peerId || settled === peerId || me === null)
  return (
    <div data-ready={ready ? '' : undefined} className="space-y-6">
      <PageHeader ref={title} title={entry.title} icon={entry.icon} />
      <div className="md:grid md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:items-start md:gap-6">
        <div className={peerId ? 'hidden md:block' : undefined}>
          {failed ? (
            <LoadError ref={retryButton} onRetry={retry} />
          ) : !list ? (
            <Loading label="Chargement des conversations" />
          ) : list.length ? (
            <ul ref={conversations} aria-label="Conversations" className="card-frame divide-y divide-[var(--color-border)] overflow-hidden">
              {list.map((c) => <Entry key={c.peer_id} c={c} current={c.peer_id === peerId} />)}
            </ul>
          ) : (
            <div className="card-frame space-y-1 p-6 text-center text-sm">
              <p>Aucune conversation.</p>
              <p>Écris à un ami depuis la page <Link href="/friends" className={link}>Amis</Link>.</p>
            </div>
          )}
        </div>
        <div className={peerId ? 'min-w-0 space-y-3' : 'hidden md:block'}>
          {peerId ? (
            <>
              <Link href="/dms" className={`${link} md:hidden`}>← Conversations</Link>
              {me && <Thread key={peerId} peerId={peerId} me={me} onSent={() => void read(true)} onSettled={() => setSettled(peerId)} />}
            </>
          ) : (
            <p className="card-frame p-6 text-center text-sm text-[var(--color-foreground)]/70">Choisis une conversation.</p>
          )}
        </div>
      </div>
    </div>
  )
}

// Une conversation : avatar décoratif de 40 px (alt vide, D:753), pseudo, dernier message sur une ligne, date ; les non-lues en gras, avec
// leur pastille (son nombre dit en toutes lettres aux lecteurs d'écran).
function Entry({ c, current }: { c: Conversation; current: boolean }) {
  const n = c.unread_count
  return (
    <li>
      <Link
        href={`/dms?with=${c.peer_id}`}
        aria-current={current ? 'page' : undefined}
        // Anneau de focus dedans : la liste arrondie coupe ce qui dépasse (overflow-hidden).
        className={`flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-light)] focus-visible:-outline-offset-2 ${current ? 'bg-[var(--color-surface-light)]' : ''}`}
      >
        {c.peer_avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.peer_avatar_url} alt="" className="size-10 shrink-0 rounded-full object-cover" />
        ) : (
          <span aria-hidden="true" className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-light)] font-bold text-[var(--color-accent)]">
            {[...c.peer_username][0]?.toUpperCase()}
          </span>
        )}
        <span className={`min-w-0 flex-1 ${n ? 'font-bold' : ''}`}>
          <span className="flex items-baseline justify-between gap-2">
            <span className={`min-w-0 wrap-anywhere ${n ? '' : 'font-medium'}`}>{c.peer_username}</span>
            <span className="shrink-0 text-xs text-[var(--color-foreground)]/70">{formatShortDate(c.last_message_at)}</span>
          </span>
          <span className={`line-clamp-1 wrap-anywhere text-sm ${n ? '' : 'text-[var(--color-foreground)]/70'}`}>{c.last_message}</span>
        </span>
        {n > 0 && (
          <span className="inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 text-xs font-bold text-[var(--color-accent-foreground)]">
            <span aria-hidden="true">{formatInt(n)}</span>
            <span className="sr-only">{`${formatInt(n)} ${n > 1 ? 'messages non lus' : 'message non lu'}`}</span>
          </span>
        )}
      </Link>
    </li>
  )
}
