'use client'

import Link from 'next/link'
import { Fragment, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { link, primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { api, ApiError, apiOnce, unsure, userMessage } from '@/lib/api'
import { formatInt, formatLongDate, formatTime } from '@/lib/format'
import { unreadStore } from '@/lib/notifications'
import { usePoll } from '@/lib/poll'
import { PeerParams } from '@/lib/schemas'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import type { GuildChat, Message, Thread as Data } from './types'

const MAX = 2000
const GUILD_MAX = 1000
// Réponse perdue, 5xx ou corps illisible : le message a pu être créé ; renvoyé tel quel, il garde sa clé et le serveur rejoue sa réponse.
const UNSURE = 'Le message n\'a pas été confirmé : il a peut-être été envoyé. La conversation se met à jour.'
const GUILD_UNSURE = 'Le message n\'a pas été confirmé : il a peut-être été envoyé. Le chat se met à jour.'
// En-tête d'un fil de guilde : lu comme un fil d'amis (champ de saisie, pas de pair).
const GUILD_HEAD: Omit<Data, 'messages'> = { peer: { id: '', username: '', avatar_url: null }, isFriend: true }
// Un message de guilde est rendu comme un message privé : l'auteur est l'expéditeur.
const fromGuild = (m: GuildChat): Message => ({ id: m.id, sender_id: m.user_id, recipient_id: '', content: m.content, read: true, created_at: m.created_at, username: m.username })
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// Fil avec un pair (/dms?with=<id>), remonté pour chaque pair (key), ou chat de la guilde (G13 : même fil, autre canal). Lu à chaque
// affichage (Activity compris), puis toutes les 5 s tant que la page est visible ; le main défile, jamais un conteneur du fil (R§6.3), la
// saisie collée en bas. Aucun id fixe (useId). Chat de guilde : /api/guilds/chat, 1 000 caractères, pseudo au-dessus de la bulle d'un autre,
// ni pair, ni marquage lu, ni « Joueur introuvable » ; un 404 (plus de guilde) appelle onGone.
export function Thread({ channel, me, onSent, onSettled, onGone }: {
  channel: { kind: 'dm'; peerId: string } | { kind: 'guild' }; me: string; onSent: () => void; onSettled: () => void; onGone?: () => void
}) {
  const guild = channel.kind === 'guild'
  const peerId = channel.kind === 'dm' ? channel.peerId : ''
  const path = guild ? '/api/guilds/chat' : `/api/chat/${encodeURIComponent(peerId)}`
  const max = guild ? GUILD_MAX : MAX
  const id = useId()
  const [head, setHead] = useState<Omit<Data, 'messages'> | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [failed, setFailed] = useState(false)
  // Adresse qui n'est pas un UUID (règle de la route) : introuvable d'emblée, sans requête (`/api/chat/.` mènerait à la liste).
  const [missing, setMissing] = useState(() => !guild && !PeerParams.safeParse({ peerId }).success)
  const [value, setValue] = useState('')
  // Un envoi à la fois : aria-disabled et garde, jamais disabled ; le champ en readOnly.
  const [sending, setSending] = useState(false)
  // Échec du dernier envoi (role=alert) : un refus reste jusqu'à l'envoi suivant, une issue incertaine jusqu'au premier message nouveau lu.
  const [error, setError] = useState<{ text: string; unsure: boolean } | null>(null)
  const inflight = useRef(false)
  // Faux une fois le fil caché (Activity) ou démonté (autre pair) : une lecture encore en vol ne marque plus rien lu.
  const live = useRef(false)
  // Clés des envois (B15) : aucune relecture ne les oublie, seulement apiOnce (réponse lue) et toute modification du champ.
  const keys = useRef(new Map<string, string>())
  // Lectures ordonnées : seule la dernière partie s'applique ; celles parties avant la réponse d'un envoi sont jetées (hold).
  const gen = useRef(0)
  const hold = useRef(0)
  // Messages affichés, à jour avant leur rendu : la nouveauté d'une lecture ou d'un envoi s'y mesure.
  const shown = useRef<Message[]>([])
  // Défilement au rendu suivant : à l'ouverture, puis pour un message nouveau quand le joueur était en bas.
  // Chat de guilde : la page garde son en-tête et ses onglets à l'ouverture, seuls les messages nouveaux défilent.
  const stick = useRef<ScrollBehavior | null>(guild ? null : 'instant')
  const root = useRef<HTMLDivElement>(null)
  const items = useRef<HTMLOListElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const lost = useRef<HTMLHeadingElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const notFriend = useRef<HTMLParagraphElement>(null)

  // En bas : le dernier message entier au-dessus de la saisie collée.
  const atBottom = () => {
    const last = items.current?.lastElementChild
    return !last || !bottom.current || last.getBoundingClientRect().bottom <= bottom.current.getBoundingClientRect().top + 1
  }
  // Rend vrai si un message n'était pas encore affiché.
  const show = (next: Message[]) => {
    const old = new Set(shown.current.map((m) => m.id))
    const fresh = next.some((m) => !old.has(m.id))
    if (fresh && stick.current === null && atBottom()) stick.current = reduced() ? 'instant' : 'smooth'
    shown.current = next
    setMessages(next)
    return fresh
  }

  // Lu par le destinataire seul (RLS) ; le trigger marque aussi la notification chat_message du couple, que la cloche relit. Un échec ne
  // fait rien : le poll suivant réessaie.
  const markRead = () => void createBrowserSupabase().from('chat_messages').update({ read: true })
    .eq('sender_id', peerId).eq('recipient_id', me).eq('read', false)
    .then(({ error: e }) => { if (!e) void unreadStore().refresh() }, () => {})

  const read = () => {
    const g = ++gen.current
    const started = performance.now()
    return api<Data | { messages: GuildChat[] } | null>(path).then((r) => {
      if (g !== gen.current || started < hold.current) return
      // 2xx au corps illisible (api() rend null) ou sans `messages` : une lecture en échec ; le fil affiché reste, brouillon compris.
      if (!Array.isArray(r?.messages)) return setFailed(true)
      if (guild) {
        setHead(GUILD_HEAD)
        if (show((r.messages as GuildChat[]).map(fromGuild))) setError((e) => (e?.unsure ? null : e))
        return setFailed(false)
      }
      const t = r as Data
      if (!t.peer) return setFailed(true)
      setHead({ peer: t.peer, isFriend: t.isFriend })
      if (show(t.messages)) setError((e) => (e?.unsure ? null : e))
      setFailed(false)
      // Onglet caché : rien de lu ; au retour en visible, le poll relit tout de suite (lib/poll.ts) et marque alors.
      if (live.current && document.visibilityState === 'visible' && t.messages.some((m) => m.sender_id === peerId && !m.read)) markRead()
    }, (e) => {
      if (g !== gen.current || started < hold.current) return
      // Guilde : 404, plus de guilde. Fil privé : inconnu (404) ou adresse invalide (400), « Joueur introuvable », plus interrogé.
      // Autre échec : le fil affiché reste.
      if (e instanceof ApiError && e.status === 404 && guild) onGone?.()
      else if (e instanceof ApiError && (e.status === 404 || e.status === 400) && !guild) setMissing(true)
      else setFailed(true)
    })
  }
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  const onShow = useEffectEvent(() => { if (!missing) void read() })
  useEffect(() => onShow(), [])
  usePoll(read, 5_000, !missing)

  const settled = !!head || failed || missing
  const onReady = useEffectEvent(onSettled)
  useEffect(() => { if (settled) onReady() }, [settled])

  useLayoutEffect(() => {
    if (!head || !stick.current) return
    root.current?.closest('main')?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: stick.current })
    stick.current = null
  }, [head, messages])

  // Le contrôle focalisé disparaît (fil ouvert depuis la liste cachée, « Réessayer », saisie remplacée quand l'amitié change) : le focus
  // tombé sur body va au titre du fil, au « Réessayer » revenu, à « Joueur introuvable », ou à ce qui remplace la saisie.
  const kind = missing ? 'missing' : head ? (head.isFriend ? 'friend' : 'stranger') : failed ? 'failed' : null
  const prev = useRef<typeof kind>(null)
  const retried = useRef(false)
  useEffect(() => {
    if (!kind || (kind === prev.current && !retried.current)) return
    const from = prev.current
    prev.current = kind
    retried.current = false
    if (document.activeElement !== document.body) return
    if (kind === 'missing') lost.current?.focus()
    else if (kind === 'failed') retryButton.current?.focus()
    else if (from === 'friend' || from === 'stranger') (kind === 'friend' ? field : notFriend).current?.focus()
    // Sans défilement : l'ouverture montre le dernier message.
    else title.current?.focus({ preventScroll: true })
  }, [kind])

  function retry() {
    retried.current = true
    setFailed(false)
    void read()
  }

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const content = value
    // sending : entre la fin de l'envoi et le rendu qui vide le champ, un gestionnaire encore périmé tient le texte envoyé.
    if (inflight.current || sending || !content.trim()) return
    inflight.current = true
    setSending(true)
    setError(null)
    const intent = `send:${guild ? 'guild' : peerId}:${content}`
    // Seule la clé de cette intention vaut encore : une autre, gardée, rejouerait sa réponse stockée (leçon de la Task 12).
    for (const k of keys.current.keys()) if (k !== intent) keys.current.delete(k)
    try {
      const r = await apiOnce<{ message?: Message | GuildChat } | null>(keys.current, intent, path, {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
      // 2xx au corps illisible : apiOnce garde la clé, issue incertaine.
      if (r === null) throw new Error('Réponse illisible')
      // Posé à la réponse, jamais au départ : un poll parti pendant le POST déferait le message.
      hold.current = performance.now()
      // Succès ou rejeu : fusionné par id, sans seconde bulle si un poll l'a déjà montré. Un 2xx lisible sans `message` est envoyé aussi
      // (apiOnce a oublié sa clé : le renvoyer le doublerait) ; la lecture suivante le montre. Le focus reste dans le champ.
      const m = r.message && guild ? fromGuild(r.message as GuildChat) : (r.message as Message | undefined)
      if (m?.id && !shown.current.some((x) => x.id === m.id)) show([...shown.current, m])
      setValue('')
      onSent()
    } catch (err) {
      // Guilde quittée ou exclusion entre-temps : l'écran se relit (le texte est perdu avec le fil).
      if (guild && err instanceof ApiError && err.status === 404) return void onGone?.()
      const maybe = unsure(err)
      if (!maybe) hold.current = performance.now()
      // Refus : le texte reste dans le champ.
      setError({ text: userMessage(err, maybe ? (guild ? GUILD_UNSURE : UNSURE) : 'L\'action n\'a pas abouti.'), unsure: maybe })
    } finally {
      inflight.current = false
      setSending(false)
    }
  }

  if (missing) {
    return (
      <div className="card-frame flex flex-col items-center gap-3 p-6 text-center">
        <h2 ref={lost} tabIndex={-1} className="text-lg font-bold outline-none">Joueur introuvable</h2>
        <Link href="/dms" className={link}>Retour aux messages</Link>
      </div>
    )
  }
  if (!head) return failed ? <LoadError ref={retryButton} onRetry={retry} /> : <Loading label="Chargement des messages" />
  const { peer } = head
  // Pseudo lu en clair : encodé dans le lien (pseudo hérité).
  const profile = `/profile/${encodeURIComponent(peer.username)}`
  const off = sending || !value.trim()
  return (
    <div ref={root} className="space-y-3">
      {!guild && (
        <h2 ref={title} tabIndex={-1} className="text-lg font-bold outline-none">
          <Link href={profile} className="inline-flex min-h-11 items-center wrap-anywhere text-[var(--color-accent-light)] underline-offset-2 hover:underline">
            {peer.username}
          </Link>
        </h2>
      )}
      {/* Sans rôle sur l'ol ni ses li : un ol au rôle log perdrait sa sémantique de liste (axe listitem). */}
      <div role="log" aria-label={guild ? 'Chat de la guilde' : `Messages avec ${peer.username}`}>
        {messages.length ? (
          <ol ref={items} className="space-y-2">
            {messages.map((m, i) => {
              const mine = m.sender_id === me
              const day = formatLongDate(m.created_at)
              const name = guild ? m.username ?? '' : peer.username
              return (
                <Fragment key={m.id}>
                  {(i === 0 || formatLongDate(messages[i - 1].created_at) !== day) && (
                    <li className="py-2 text-center text-xs font-medium text-[var(--color-foreground)]/70">{day}</li>
                  )}
                  <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`min-w-0 max-w-[85%] rounded-2xl px-3 py-2 ${mine ? 'bg-[var(--color-accent)]/15' : 'bg-[var(--color-surface-light)]'}`}>
                      {guild && !mine && (
                        <Link href={`/profile/${encodeURIComponent(name)}`} className={`${link} wrap-anywhere`}>{name}</Link>
                      )}
                      <p className="whitespace-pre-wrap wrap-anywhere text-sm">
                        <span className="sr-only">{mine ? 'Toi : ' : `${name} : `}</span>
                        {m.content}
                      </p>
                      <time dateTime={m.created_at} className="mt-1 block text-right text-xs text-[var(--color-foreground)]/70">{formatTime(m.created_at)}</time>
                    </div>
                  </li>
                </Fragment>
              )
            })}
          </ol>
        ) : (
          <p className="card-frame p-6 text-center text-sm">Aucun message pour l&apos;instant.</p>
        )}
      </div>
      <div ref={bottom} className="sticky bottom-0 space-y-2 border-t border-[var(--color-border)] bg-[var(--color-background)] py-3">
        {head.isFriend ? (
          <form onSubmit={(e) => void send(e)} className="space-y-2">
            <textarea
              ref={field}
              aria-label="Ton message"
              aria-describedby={`${id}-help ${id}-count`}
              value={value}
              maxLength={max}
              rows={2}
              readOnly={sending}
              onChange={(e) => {
                keys.current.clear()
                setValue(e.target.value)
              }}
              // U9 : Entrée envoie ; Maj+Entrée va à la ligne ; Entrée qui valide une composition IME n'envoie rien (Safari la signale par
              // keyCode 229 après compositionend) ; une touche maintenue (repeat) n'envoie qu'une fois.
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
                e.preventDefault()
                if (!e.repeat) void send()
              }}
              className="block w-full resize-y rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm"
            />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p id={`${id}-help`} className="text-xs text-[var(--color-foreground)]/70">Entrée pour envoyer, Maj+Entrée pour aller à la ligne.</p>
              <div className="flex items-center gap-3">
                {/* value.length : unités UTF-16, plus strict que les caractères comptés par le serveur, jamais plus large. */}
                <span id={`${id}-count`} className="text-xs tabular-nums text-[var(--color-foreground)]/70">{`${formatInt(value.length)} / ${formatInt(max)}`}</span>
                <button type="submit" aria-disabled={off || undefined} className={`${primary} justify-center`}>Envoyer</button>
              </div>
            </div>
            {error && <p role="alert" className="text-sm font-medium text-red-400">{error.text}</p>}
          </form>
        ) : (
          <>
            <p ref={notFriend} tabIndex={-1} className="text-sm font-medium outline-none">Vous devez être amis pour vous écrire</p>
            <Link href={profile} className={`${link} wrap-anywhere`}>{`Profil de ${peer.username}`}</Link>
          </>
        )}
      </div>
    </div>
  )
}
