'use client'

import Link from 'next/link'
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { ghost, primary } from '@/components/ui/button'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/toast'
import { api, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { unreadStore } from '@/lib/notifications'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/friends')
const danger = 'inline-flex min-h-11 items-center rounded-xl bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800 aria-disabled:cursor-progress aria-disabled:opacity-80'
const row = 'flex flex-wrap items-center justify-between gap-2 px-4 py-2'
// Un pseudo de 24 caractères sans coupure passe à la ligne au lieu d'élargir la page (360 px).
const who = 'min-w-0 font-medium wrap-anywhere'

type Player = { id: string; username: string; avatar_url: string | null }
type Friendship = { id: string; status: 'pending' | 'accepted'; requester_id: string; addressee_id: string; requester: Player; addressee: Player; created_at: string }
type Part = 'received' | 'sent' | 'friends'
// Après une relecture, si le focus est tombé sur body : la ligne de ce rang dans sa section (la suivante a pris sa place), ou la première
// de ces amitiés ; dans la ligne, le contrôle de même nom (« Refuser » → « Refuser »), sinon le premier ; à défaut, l'état vide.
type Focus = { part: Part; row: number | string[]; name?: string }
const SHORT = 'La recherche demande au moins 2 caractères'

// Sections d'après le joueur de la session du navigateur (P16).
const split = (me: string, rows: Friendship[]): Record<Part, Friendship[]> => ({
  received: rows.filter((f) => f.status === 'pending' && f.addressee_id === me),
  sent: rows.filter((f) => f.status === 'pending' && f.requester_id === me),
  friends: rows.filter((f) => f.status === 'accepted'),
})

// /friends (M4-15) : recherche, demandes reçues et envoyées, amis. Seul id fixe : #friend-list-search (R§6.8).
export function FriendsClient() {
  const id = useId()
  const [data, setData] = useState<{ me: string; rows: Friendship[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState('')
  const [hits, setHits] = useState<Player[] | null>(null)
  // Recherches finies : clé du texte de la région status, remonté (donc annoncé) même quand le compte ne change pas.
  const [searches, setSearches] = useState(0)
  // Recherche trop courte ou refusée.
  const [note, setNote] = useState<string | null>(null)
  // Amitié de la modale de retrait et son rang dans « Amis » à l'ouverture.
  const [confirm, setConfirm] = useState<{ f: Friendship; i: number } | null>(null)
  // Une action à la fois, jusqu'à sa relecture : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  // Générations : une réponse tardive n'écrase pas celle d'une recherche, ou d'une lecture, plus récente.
  const searchGen = useRef(0)
  const readGen = useRef(0)
  const applied = useRef(0)
  const refocus = useRef<Focus | null>(null)
  // Cible d'une action ou de « Réessayer », et la génération de sa lecture : prise par cette lecture ou une plus récente, jamais effacée
  // par une relecture de fond.
  const pending = useRef<{ g: number; focus: Focus } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)

  // Relecture de fond, sans cible : celle de l'élément focalisé (sa section, son rang, son nom), une ligne pouvant changer de section
  // sous lui ; « Réessayer » → la première section ; hors des sections, aucune.
  const focused = (): Focus | null => {
    const el = document.activeElement
    if (el && el === retryButton.current) return { part: 'received', row: 0 }
    const box = el?.closest<HTMLElement>('[data-part]')
    if (!el || !box || !root.current?.contains(box)) return null
    const row = [...box.querySelectorAll(':scope > ul > li')].findIndex((li) => li.contains(el))
    return { part: box.dataset.part as Part, row: Math.max(row, 0), name: el.textContent ?? undefined }
  }

  // Sans polling propre (Q25 : la cloche signale les demandes) : lue à chaque affichage (Activity compris), à chaque lecture de la cloche,
  // après chaque action et sur « Réessayer ». keep : relecture de fond, dont l'échec laisse la page telle quelle (comme /trades).
  const read = (focus: Focus | null = null, keep = false) => {
    const g = ++readGen.current
    if (focus) pending.current = { g, focus }
    return Promise.all([api<{ friendships: Friendship[] }>('/api/friends'), createBrowserSupabase().auth.getSession()]).then(
      // Corps illisible (api() rend null pour un 2xx qui n'est pas du JSON) : lecture en échec, jamais une exception qui bloquerait act().
      ([r, { data: auth }]) => (auth.session && Array.isArray(r?.friendships) ? { me: auth.session.user.id, rows: r.friendships } : null),
      () => null,
    ).then((next) => {
      // Partie avant la dernière appliquée (première lecture lente, réaffichage par Activity) : elle déferait la relecture d'une action.
      if (g < applied.current || (!next && keep)) return
      applied.current = g
      // État du serveur relu : une relance est une nouvelle intention, refusée par l'état de la ligne si elle a déjà eu lieu. Une clé
      // gardée rejouerait l'ancien succès (« Ajouter » après un retrait : la réponse stockée, et aucune demande créée).
      if (next) keys.current.clear()
      const p = pending.current && g >= pending.current.g ? pending.current.focus : null
      if (p) pending.current = null
      // Une cible non consommée (fermeture de la modale) reste si rien de focalisé n'est à suivre.
      refocus.current = p ?? focused() ?? refocus.current
      if (next) setData(next)
      setFailed(!next)
    })
  }
  // Version du poller partagé de la cloche (M4-13), aucun de plus : une relecture par passage (30 s, onglet visible), même à « 9+ » ;
  // abonnement retiré au démontage et au masquage par Activity. À froid, la première lecture de la cloche en fait une seconde (admise).
  const version = useSyncExternalStore(unreadStore().subscribe, unreadStore().getVersion, () => 0)
  // Liste affichée : relecture de fond ; sans liste (première lecture), son échec montre la carte d'erreur.
  const onShow = useEffectEvent(() => void read(null, data !== null))
  useEffect(() => onShow(), [version])

  // Relecture rendue, ou modale fermée : une ligne disparue sous le focus le passe à sa voisine ou à l'état vide (modale déjà démontée,
  // son focus rendu au « Retirer » de la ligne s'il existe encore), une lecture en échec au « Réessayer ». Rien si le joueur a mis le
  // focus ailleurs pendant la requête.
  useEffect(() => {
    const f = refocus.current
    refocus.current = null
    if (!f || document.activeElement !== document.body) return
    if (failed || !data) return retryButton.current?.focus()
    const { part, row, name } = f
    const rows = split(data.me, data.rows)[part]
    const i = Array.isArray(row) ? rows.findIndex((x) => row.includes(x.id)) : row
    const box = root.current?.querySelector(`[data-part="${part}"]`)
    const items = box?.querySelectorAll(':scope > ul > li')
    const controls = [...(items?.[Math.min(Math.max(i, 0), items.length - 1)]?.querySelectorAll<HTMLElement>('a, button') ?? [])]
    ;(controls.find((c) => c.textContent === name) ?? controls[0] ?? box?.querySelector<HTMLElement>('[tabindex="-1"]'))?.focus()
  }, [data, failed, confirm])

  async function search(e: FormEvent) {
    e.preventDefault()
    const q = text.trim()
    const g = ++searchGen.current
    // Seuil du serveur (wm.friend_search) en caractères : refusé sur place, sans requête.
    if ([...q].length < 2) {
      setHits(null)
      return setNote(SHORT)
    }
    setNote(null)
    try {
      const r = await api<{ users: Player[] }>(`/api/friends/search?${new URLSearchParams({ q })}`)
      if (g !== searchGen.current) return
      setHits(r.users)
      setSearches((n) => n + 1)
    } catch (err) {
      if (g !== searchGen.current) return
      setHits(null)
      setNote(userMessage(err, 'La recherche n\'a pas abouti.'))
    }
  }

  // Relue même après un refus : la demande a pu changer ailleurs. Une issue inconnue garde sa clé (apiOnce) : la relance rejoue, jusqu'à la
  // prochaine relecture réussie.
  async function act<T>(intent: string, path: string, init: RequestInit, done: (r: T) => string, focus: Focus | null = null) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    try {
      toast(done(await apiOnce<T>(keys.current, intent, path, init)))
    } catch (e) {
      toast(userMessage(e, unsure(e) ? UNSURE : 'L\'action n\'a pas abouti.'))
    }
    // Modale démontée avant la relecture : elle rend le focus au « Retirer » de la ligne, que la relecture retire ensuite.
    setConfirm(null)
    await read(focus)
    inflight.current = false
    setBusy(false)
  }

  const answer = (f: Friendship, i: number, action: 'accept' | 'decline', done: string) =>
    act(`${action}:${f.id}`, `/api/friends/${f.id}`, { method: 'PATCH', body: JSON.stringify({ action }) }, () => done,
      { part: 'received', row: i, name: action === 'accept' ? 'Accepter' : 'Refuser' })
  const remove = (f: Friendship, part: Part, i: number, done: string) =>
    act(`remove:${f.id}`, `/api/friends/${f.id}`, { method: 'DELETE' }, () => done, { part, row: i, name: 'Retirer' })

  // Chargement jusqu'à la relecture : jamais l'ancienne liste et ses boutons actifs. Le bouton disparaît pendant la relecture : le focus va
  // ensuite à la première section.
  function retry() {
    setData(null)
    setFailed(false)
    void read({ part: 'received', row: 0 })
  }

  // Échap, voile ou « Annuler », jamais pendant le retrait. Une relecture a pu retirer la ligne d'origine sous la modale : le focus
  // rendu tombe alors sur body, et l'effet le passe au « Retirer » de la ligne de même rang.
  const close = () => {
    if (inflight.current || !confirm) return
    refocus.current = { part: 'friends', row: confirm.i, name: 'Retirer' }
    setConfirm(null)
  }

  const me = data?.me ?? ''
  const s = data && split(me, data.rows)
  // Chaque ligne montre l'autre joueur.
  const other = (f: Friendship) => (f.requester_id === me ? f.addressee : f.requester)

  return (
    <div ref={root} data-ready={data || failed ? '' : undefined} className="space-y-6">
      <PageHeader title={entry.title} icon={entry.icon} />

      <div>
        <form role="search" onSubmit={search} className="flex">
          {/* Envoi sur Entrée (un seul champ : soumission implicite). */}
          <input
            id="friend-list-search"
            type="search"
            aria-label="Rechercher un joueur"
            placeholder="Rechercher un joueur…"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setNote(null)
            }}
            aria-invalid={note === SHORT || undefined}
            aria-describedby={note ? `${id}-note` : undefined}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm placeholder:text-[var(--color-foreground)]/60"
          />
        </form>
        {note && <p id={`${id}-note`} role="alert" className="mt-3 text-sm font-medium text-red-400">{note}</p>}
        {/* Région présente dès le rendu, vide d'abord : le résultat de chaque recherche aboutie y est annoncé (un refus, par l'alerte). */}
        <div role="status">
          {hits && (hits.length
            ? <p key={searches} className="sr-only">{`${formatInt(hits.length)} ${hits.length > 1 ? 'joueurs trouvés' : 'joueur trouvé'}.`}</p>
            : <p key={searches} className="mt-3 text-sm">Aucun joueur ne correspond.</p>)}
        </div>
        {!!hits?.length && (
          <ul aria-label="Résultats de la recherche" className="mt-3 card-frame divide-y divide-[var(--color-border)]">
            {hits.map((p) => (
              <li key={p.id} className={row}>
                <span id={`${id}-hit-${p.id}`} className={who}>{p.username}</span>
                <button
                  type="button"
                  aria-disabled={busy || undefined}
                  aria-describedby={`${id}-hit-${p.id}`}
                  onClick={() => void act(`add:${p.id}`, '/api/friends', { method: 'POST', body: JSON.stringify({ addressee_id: p.id }) }, () => `Demande envoyée à ${p.username}.`)}
                  className={primary}
                >
                  Ajouter
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {failed ? (
        <LoadError ref={retryButton} onRetry={retry} />
      ) : !s ? (
        <Loading label="Chargement des amis" />
      ) : (
        <>
          <Section
            part="received"
            title="Demandes reçues"
            empty="Aucune demande reçue."
            rows={s.received}
            other={other}
            head={s.received.length > 0 && (
              <button
                type="button"
                aria-disabled={busy || undefined}
                onClick={() => void act<{ accepted: number }>('accept-all', '/api/friends/accept-all', { method: 'POST' },
                  (r) => `${formatInt(r.accepted)} ${r.accepted > 1 ? 'demandes acceptées' : 'demande acceptée'}.`,
                  { part: 'friends', row: s.received.map((f) => f.id) })}
                className={ghost}
              >
                Tout accepter
              </button>
            )}
          >
            {(f, i, desc) => (
              <>
                <button type="button" aria-disabled={busy || undefined} aria-describedby={desc} onClick={() => void answer(f, i, 'accept', `${other(f).username} fait maintenant partie de tes amis.`)} className={primary}>
                  Accepter
                </button>
                <button type="button" aria-disabled={busy || undefined} aria-describedby={desc} onClick={() => void answer(f, i, 'decline', 'Demande refusée.')} className={ghost}>
                  Refuser
                </button>
              </>
            )}
          </Section>
          <Section part="sent" title="Demandes envoyées" empty="Aucune demande envoyée." rows={s.sent} other={other}>
            {(f, i, desc) => (
              <button type="button" aria-disabled={busy || undefined} aria-describedby={desc} onClick={() => void remove(f, 'sent', i, 'Demande retirée.')} className={ghost}>
                Retirer
              </button>
            )}
          </Section>
          <Section part="friends" title="Amis" empty="Tu n'as pas encore d'amis. Cherche un joueur par son pseudo." rows={s.friends} other={other}>
            {(f, i, desc) => (
              <>
                <Link href={`/trades/new?with=${other(f).id}`} aria-describedby={desc} className={ghost}>Échanger</Link>
                {/* Inactif pendant une action : sa fin ferme la modale (act). */}
                <button type="button" aria-disabled={busy || undefined} aria-describedby={desc} onClick={() => { if (!busy) setConfirm({ f, i }) }} className={ghost}>
                  Retirer
                </button>
              </>
            )}
          </Section>
        </>
      )}

      {confirm && s && (
        <Modal onClose={close} labelledBy={`${id}-confirm`} className="card-frame relative w-full max-w-md animate-fade-in-up space-y-4 p-6">
          <h2 id={`${id}-confirm`} className="text-xl font-bold wrap-anywhere">{`Retirer ${other(confirm.f).username} de tes amis ?`}</h2>
          <p className="text-sm">Les échanges en attente entre vous seront annulés.</p>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
            <button
              type="button"
              aria-disabled={busy || undefined}
              // Rang relu à la confirmation : une relecture a pu décaler les lignes depuis l'ouverture.
              onClick={() => {
                const i = s.friends.findIndex((f) => f.id === confirm.f.id)
                void remove(confirm.f, 'friends', i < 0 ? confirm.i : i, `${other(confirm.f).username} a été retiré de tes amis.`)
              }}
              className={danger}
            >
              Retirer
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// Une section : son titre (et « Tout accepter »), ses lignes, ou son état vide focalisable (tabIndex -1) quand une ligne disparaît sous le focus.
// Les contrôles d'une ligne sont décrits par son pseudo (desc, id de useId) : leur nom reste le texte visible.
function Section({ part, title, empty, rows, other, head, children }: {
  part: Part
  title: string
  empty: string
  rows: Friendship[]
  other: (f: Friendship) => Player
  head?: ReactNode
  children: (f: Friendship, i: number, desc: string) => ReactNode
}) {
  const id = useId()
  return (
    <section data-part={part} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{title}</h2>
        {head}
      </div>
      {rows.length ? (
        <ul className="card-frame divide-y divide-[var(--color-border)]">
          {rows.map((f, i) => (
            <li key={f.id} className={row}>
              <span id={`${id}-${f.id}`} className={who}>{other(f).username}</span>
              <div className="flex flex-wrap gap-2">{children(f, i, `${id}-${f.id}`)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p tabIndex={-1} className="card-frame p-6 text-center text-sm outline-none">{empty}</p>
      )}
    </section>
  )
}
