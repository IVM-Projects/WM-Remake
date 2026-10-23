'use client'

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { ghost as ghostBase } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { ReadError, Section } from '@/components/ui/Section'
import { api, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { PUSH_FAMILIES } from '@/lib/notification-view'
import { pushState, subscribePush, unsubscribePush } from '@/lib/push-browser'

type Device = Awaited<ReturnType<typeof pushState>>['state']
type Prefs = { push_types: string[]; vapid_public: string | null }
type View = Prefs & { device: Device }

const PREFS = '/api/settings/notifications' as const
const SUBSCRIBE = '/api/push/subscribe' as const
const FAILED = 'L\'activation a échoué, réessaie.'
const NOT_DONE = 'L\'action n\'a pas abouti.'
const ghost = `${ghostBase} justify-center gap-2 self-start`
const hint = 'text-sm text-[var(--color-foreground)]/70'

// État de l'appareil, en role="status" et jamais en alerte : sans stub, la CI (chromium-headless-shell) voit « bloquées ».
const deviceText = (v: View) =>
  v.device === 'unsupported' ? 'Ton navigateur ne gère pas les notifications push.'
  : v.device === 'denied' ? 'Les notifications sont bloquées pour ce site : autorise-les dans les réglages de ton navigateur.'
  : !v.vapid_public ? 'Les notifications push ne sont pas disponibles pour l\'instant.'
  : v.device === 'on' ? 'Notifications activées sur cet appareil.' : ''
// État affiché auquel s'attache une alerte : elle tombe quand il change.
const shownAt = (v: View) => `${v.device}|${v.push_types.join()}`
// 2xx sans `push_types` lisible (api() rend null pour un corps illisible) : une lecture en échec.
const readPrefs = () => api<Prefs | null>(PREFS).then(
  (r) => (r && Array.isArray(r.push_types) ? { push_types: r.push_types, vapid_public: r.vapid_public ?? null } : null),
  () => null,
)

// « Notifications » de /settings (M4b-13, B17, B18) : familles en opt-in, valables pour tous les appareils, et abonnement de cet appareil.
export function PushSection() {
  const id = useId()
  // null : en lecture ; false : lecture en échec.
  const [view, setView] = useState<View | null | false>(null)
  // Liste affichée pendant l'enregistrement d'une famille.
  const [sending, setSending] = useState<string[] | null>(null)
  const [failure, setFailure] = useState<{ text: string; at: string } | null>(null)
  // Une lecture ou une écriture à la fois (ni course ni clé d'une autre en vol) : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  // Clés apiOnce par ressource (les familles, la ligne de l'appareil), comme les sections de /profile.
  const keys = useRef({ [PREFS]: new Map<string, string>(), [SUBSCRIBE]: new Map<string, string>() })

  async function guard(fn: () => Promise<void>) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    try {
      await fn()
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }
  const show = (v: View, text: string | null) => {
    setView(v)
    if (text) setFailure({ text, at: shownAt(v) })
  }

  // Seule la clé de cette intention vaut encore pour sa ressource : une autre, gardée, rejouerait sa réponse stockée (X perdu, Y perdu,
  // puis X). Un 2xx illisible, ou sans sa clé, est une issue incertaine.
  async function write<T>(intent: string, path: typeof PREFS | typeof SUBSCRIBE, method: string, body: object, valid: (r: T) => boolean): Promise<void> {
    const kept = keys.current[path]
    for (const k of kept.keys()) if (k !== intent) kept.delete(k)
    const r = await apiOnce<T | null>(kept, intent, path, { method, body: JSON.stringify(body) })
    if (!r || !valid(r)) throw new Error('Réponse illisible')
  }
  // Ligne de l'appareil, upsert par endpoint ; aucune préférence écrite.
  const send = (sub: PushSubscriptionJSON) => write<{ ok: boolean }>(`subscribe:${sub.endpoint}`, SUBSCRIBE, 'POST', sub, (r) => r.ok === true)

  // Préférences, état de l'appareil, puis renvoi de son abonnement (B18) : un navigateur partagé passe au joueur connecté, une ligne
  // perdue ou évincée revient. « activées » n'est dit qu'après la réponse.
  const read = () => guard(async () => {
    const prefs = await readPrefs()
    if (!prefs) return setView(false)
    // État relu : une relance est une nouvelle intention, qu'une clé gardée rejouerait avec une réponse ancienne.
    Object.values(keys.current).forEach((k) => k.clear())
    const { state, sub } = await pushState().catch(() => ({ state: 'unsupported' as const, sub: null }))
    const failed = prefs.vapid_public && sub ? await send(sub).then(() => false, () => true) : false
    show({ ...prefs, device: failed ? 'off' : state }, failed ? FAILED : null)
  })
  // À chaque affichage (Activity compris), jamais après « Activer », qui vient d'envoyer l'abonnement.
  const onShow = useEffectEvent(() => void read())
  useEffect(() => onShow(), [])

  // « Réessayer » disparaît avec l'erreur : le focus attend sur le titre.
  function retry() {
    document.getElementById('settings-notifications')?.focus()
    setFailure(null)
    setView(null)
    void read()
  }

  // Toute la liste, triée. Refus : la case revient comme avant. Issue incertaine : la clé reste (apiOnce), et la case prend la valeur relue.
  const toggle = (types: readonly string[], on: boolean) => guard(async () => {
    if (!view) return
    const before = view.push_types
    const next = (on ? [...new Set([...before, ...types])] : before.filter((t) => !types.includes(t))).sort()
    setSending(next)
    setFailure(null)
    let now: string[] | undefined
    let text: string | null = null
    try {
      await write<Prefs>(JSON.stringify(next), PREFS, 'POST', { push_types: next }, (r) => Array.isArray(r.push_types))
      now = next
    } catch (e) {
      text = unsure(e) ? UNSURE : userMessage(e, NOT_DONE)
      if (unsure(e)) now = (await readPrefs())?.push_types
    }
    setSending(null)
    show({ ...view, push_types: now ?? before }, text)
  })

  // Échec du navigateur (permission refusée…) : connu, rien n'est parti. Issue du serveur inconnue : le texte du B12 (PF3).
  const activate = () => guard(async () => {
    if (!view || !view.vapid_public || !view.push_types.length) return
    setFailure(null)
    let sub: PushSubscriptionJSON | null = null
    let text: string | null = null
    try {
      sub = await subscribePush(view.vapid_public)
      await send(sub)
    } catch (e) {
      text = sub && unsure(e) ? UNSURE : FAILED
    }
    show({ ...view, device: text ? 'off' : 'on' }, text)
  })

  // Navigateur désabonné d'abord, puis sa ligne (B18) : un DELETE perdu ne laisse qu'une ligne morte, effacée au premier 410.
  const deactivate = () => guard(async () => {
    if (!view) return
    setFailure(null)
    let endpoint: string | null | undefined
    let text: string | null = null
    try {
      endpoint = await unsubscribePush()
      if (endpoint) await write<{ ok: boolean }>(`unsubscribe:${endpoint}`, SUBSCRIBE, 'DELETE', { endpoint }, (r) => r.ok === true)
    } catch (e) {
      text = endpoint !== undefined && unsure(e) ? UNSURE : NOT_DONE
    }
    show({ ...view, device: endpoint === undefined ? view.device : 'off' }, text)
  })

  const list = view ? sending ?? view.push_types : []
  // Sans famille, « Activer » attend (B17) ; un seul bouton, renommé : le focus le suit d'un état à l'autre.
  const empty = !!view && view.device === 'off' && !view.push_types.length
  return (
    <Section id="settings-notifications" title="Notifications" ready={view !== null}>
      {view === null ? (
        <Loading label="Chargement des notifications push" />
      ) : view === false ? (
        <ReadError onRetry={retry}>Tes notifications n&apos;ont pas pu être chargées.</ReadError>
      ) : (
        <>
          <ul>
            {PUSH_FAMILIES.map(({ label, types }) => (
              <li key={label}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 font-medium">
                  <input
                    type="checkbox"
                    checked={types.every((t) => list.includes(t))}
                    aria-disabled={busy || undefined}
                    onChange={(e) => void toggle(types, e.target.checked)}
                    className="size-5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                  />
                  {label}
                </label>
              </li>
            ))}
          </ul>
          <p className={hint}>Ces choix valent pour tous tes appareils.</p>
          <p role="status" className="text-sm">{deviceText(view)}</p>
          {view.vapid_public && (view.device === 'on' || view.device === 'off') && (
            <button
              type="button"
              aria-disabled={busy || empty || undefined}
              aria-describedby={empty ? `${id}-first` : undefined}
              onClick={() => void (view.device === 'on' ? deactivate() : activate())}
              className={ghost}
            >
              {view.device === 'on' ? 'Désactiver sur cet appareil' : 'Activer sur cet appareil'}
            </button>
          )}
          {empty && view.vapid_public && <p id={`${id}-first`} className={hint}>Coche d&apos;abord au moins une famille.</p>}
          {failure?.at === shownAt(view) && <p role="alert" className="text-sm font-medium text-red-400">{failure.text}</p>}
        </>
      )}
    </Section>
  )
}
