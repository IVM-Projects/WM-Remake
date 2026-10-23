'use client'

import { Plus } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from 'react'
import { Card, SIZES } from '@/components/card/Card'
import { CardPicker } from '@/components/profile/CardPicker'
import { copyFace, type ProfileView, type ShowcaseItem } from '@/components/profile/types'
import { PageHeader } from '@/components/shell/PageHeader'
import { navEntry } from '@/components/shell/nav'
import { ghost, primary } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { ReadError, Section } from '@/components/ui/Section'
import { toast } from '@/components/ui/toast'
import { api, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { createBrowserSupabase } from '@/lib/supabase/browser'

const entry = navEntry('/profile')
// Sa ligne profiles, lue en direct sous RLS (modèle /settings) ; id en plus (PF16).
type Row = { id: string; username: string; bio: string | null; is_public: boolean; avatar_url: string | null; created_at: string }
type Part = 'avatar' | 'bio' | 'public' | 'showcase'
type RowPart = Exclude<Part, 'showcase'>
const FIELD = { avatar: 'avatar_url', bio: 'bio', public: 'is_public' } as const satisfies Record<RowPart, keyof Row>
type Mine = { showcase: ShowcaseItem[] }
// Échec d'une écriture (role=alert) et l'état affiché de sa section à son départ : l'alerte tombe dès que cet état change.
type Fail = { text: string; at: string }
const ROW_FAILED = 'Ton profil n\'a pas pu être chargé.'
const hint = 'text-sm text-[var(--color-foreground)]/70'

// /profile (M4b-24) : avatar, bio, visibilité et vitrine de son profil. Quatre sections, chacune avec son chargement, son échec, sa génération
// et sa garde. Aucun id fixe (useId) ; relu à chaque affichage (Activity compris).
export function ProfileEditor() {
  const id = useId()
  // null : en lecture ; false : lecture en échec.
  const [row, setRow] = useState<Row | null | false>(null)
  const [slots, setSlots] = useState<ShowcaseItem[] | null | false>(null)
  // Bio en cours de saisie ; null : celle de la ligne.
  const [draft, setDraft] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  // Case « Profil public » pendant son envoi ; null : la valeur de la ligne.
  const [sending, setSending] = useState<boolean | null>(null)
  const [fails, setFails] = useState<Partial<Record<Part, Fail>>>({})
  const [picker, setPicker] = useState<{ mode: 'avatar' } | { mode: 'showcase'; position: number } | null>(null)
  // Une écriture par section à la fois : aria-disabled et garde, jamais disabled.
  const [busy, setBusy] = useState<Partial<Record<Part, boolean>>>({})
  const inflight = useRef(new Set<Part>())
  // Clés apiOnce par section, et les sections dont une requête est en vol (sa clé reste tant que son issue est inconnue).
  const keys = useRef<Record<Part, Map<string, string>>>({ avatar: new Map(), bio: new Map(), public: new Map(), showcase: new Map() })
  const writing = useRef(new Set<Part>())
  // Générations par section : une lecture les avance toutes, une écriture la sienne à son départ et à son arrivée ; une lecture n'applique
  // que les sections dont la génération n'a pas bougé depuis son départ.
  const gens = useRef<Record<Part, number>>({ avatar: 0, bio: 0, public: 0, showcase: 0 })
  // Titres des sections : la cible du focus de leur « Réessayer ».
  const avatarHead = useRef<HTMLHeadingElement>(null)
  const bioHead = useRef<HTMLHeadingElement>(null)
  const publicHead = useRef<HTMLHeadingElement>(null)
  const showcaseHead = useRef<HTMLHeadingElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const changeAvatar = useRef<HTMLButtonElement>(null)
  // Cible du focus quand le contrôle focalisé disparaît (« Retirer », emplacement rempli) : prise après le rendu, si le focus est sur body.
  const refocus = useRef<(() => HTMLElement | null | undefined) | null>(null)

  // Section relue : une relance est une nouvelle intention, qu'une clé gardée rejouerait avec une réponse ancienne (modifiée ailleurs entre-temps).
  // Jamais pendant une requête de la section, dont l'issue n'est pas encore connue.
  const forget = (part: Part) => {
    if (!writing.current.has(part)) keys.current[part].clear()
  }

  // Ligne absente ou en erreur : une lecture en échec. Relue avec une ligne affichée, l'échec la laisse telle quelle. Rend la ligne lue.
  const readRow = (): Promise<Row | null> => {
    const g = { avatar: ++gens.current.avatar, bio: ++gens.current.bio, public: ++gens.current.public }
    const sb = createBrowserSupabase()
    return sb.auth.getSession()
      .then(({ data: auth }) => sb.from('profiles').select('id, username, bio, is_public, avatar_url, created_at').eq('id', auth.session?.user.id ?? '').maybeSingle())
      .then(({ data, error }) => (error || !data ? null : (data as Row)), () => null)
      .then((r) => {
        const fresh = { avatar: g.avatar === gens.current.avatar, bio: g.bio === gens.current.bio, public: g.public === gens.current.public }
        if (!fresh.avatar && !fresh.bio && !fresh.public) return null
        if (r) (['avatar', 'bio', 'public'] as const).forEach((p) => { if (fresh[p]) forget(p) })
        setRow((old) => (!r ? old || false : !old ? r : {
          ...r,
          avatar_url: fresh.avatar ? r.avatar_url : old.avatar_url,
          bio: fresh.bio ? r.bio : old.bio,
          is_public: fresh.public ? r.is_public : old.is_public,
        }))
        return r
      })
  }
  // 2xx sans `showcase` lisible (api() rend null) : une lecture en échec.
  const readSlots = () => {
    const g = ++gens.current.showcase
    return api<Mine | null>('/api/showcase').then((r) => (Array.isArray(r?.showcase) ? r.showcase : null), () => null).then((s) => {
      if (g !== gens.current.showcase) return
      if (s) forget('showcase')
      setSlots((old) => s ?? (old || false))
    })
  }
  const onShow = useEffectEvent(() => {
    void readRow()
    void readSlots()
  })
  useEffect(() => onShow(), [])

  useEffect(() => {
    const el = refocus.current?.()
    if (!el) return
    refocus.current = null
    if (document.activeElement === document.body) el.focus()
  })

  // Écriture d'une section par apiOnce. Lève le texte de l'échec, avec l'erreur en cause : refus du serveur, ou issue incertaine (5xx, réseau,
  // 2xx au corps illisible) dont apiOnce garde la clé.
  async function send<T>(part: Part, intent: string, path: string, init: RequestInit): Promise<T> {
    gens.current[part]++
    writing.current.add(part)
    try {
      const r = await apiOnce<T | null>(keys.current[part], intent, path, init)
      if (!r) throw new Error('Réponse illisible')
      // Réponse lue : les autres clés gardées de la section ne valent plus (choix X incertain, puis Y, puis X : le X stocké, la base à Y).
      keys.current[part].clear()
      return r
    } catch (e) {
      throw new Error(userMessage(e, unsure(e) ? UNSURE : 'L\'action n\'a pas abouti.'), { cause: e })
    } finally {
      writing.current.delete(part)
      gens.current[part]++
    }
  }
  async function guard(part: Part, fn: () => Promise<void>) {
    if (inflight.current.has(part)) return
    inflight.current.add(part)
    setBusy((b) => ({ ...b, [part]: true }))
    try {
      await fn()
    } finally {
      inflight.current.delete(part)
      setBusy((b) => ({ ...b, [part]: false }))
    }
  }
  const fail = (part: Part, text: string | null, at = '') => setFails((f) => ({ ...f, [part]: text === null ? undefined : { text, at } }))
  // État affiché d'une section, auquel s'attache son alerte.
  const shown = (part: Part) => (part === 'showcase' ? (slots || []).map((s) => `${s.position}:${s.user_card_id}`).join() : row ? String(row[FIELD[part]]) : '')
  const alert = (part: Part) => {
    const f = fails[part]
    return f && f.at === shown(part) && <p role="alert" className="text-sm font-medium text-red-400">{f.text}</p>
  }

  // username lu en clair dans sa ligne : encodé dans l'URL de l'API (pseudo hérité).
  const patch = (part: RowPart, intent: string, body: object) =>
    send<ProfileView>(part, intent, `/api/profile/${encodeURIComponent((row as Row).username)}`, { method: 'PATCH', body: JSON.stringify(body) })
  const apply = (field: (typeof FIELD)[RowPart], r: ProfileView) => setRow((old) => old && { ...old, [field]: r.profile[field] ?? null })

  // Section seule : son échec en alerte, attaché à son état au départ.
  const act = (part: Part, fn: () => Promise<void>) => {
    const at = shown(part)
    return guard(part, () => {
      fail(part, null)
      return fn().catch((e: Error) => fail(part, e.message, at))
    })
  }

  // Depuis le sélecteur : son échec y reste affiché (onPick lève).
  const pickAvatar = (userCardId: string) => guard('avatar', async () => {
    fail('avatar', null)
    apply('avatar_url', await patch('avatar', `avatar:${userCardId}`, { avatar_user_card_id: userCardId }))
    toast('Avatar changé.')
    // Démonté, le sélecteur rend le focus à « Changer l'avatar ».
    setPicker(null)
  })
  const removeAvatar = () => act('avatar', async () => {
    apply('avatar_url', await patch('avatar', 'avatar:null', { avatar_user_card_id: null }))
    toast('Avatar retiré.')
    refocus.current = () => changeAvatar.current
  })

  const bio = row ? draft ?? row.bio ?? '' : ''
  const bioOff = !!busy.bio || !row || bio === (row.bio ?? '')
  function saveBio(e: FormEvent) {
    e.preventDefault()
    if (bioOff) return
    // Toujours une chaîne, jamais null (ruling Task 8 → 12) : vidée, le SQL la range en null.
    void act('bio', async () => {
      const r = await patch('bio', `bio:${bio}`, { bio })
      apply('bio', r)
      setDraft(null)
      setSaved('Profil enregistré.')
    })
  }

  // Enregistrée tout de suite. Refus : la case revient comme avant. Issue incertaine : la ligne relue, la case prend sa valeur, et l'alerte
  // s'attache à cette valeur.
  const togglePublic = () => guard('public', async () => {
    if (!row) return
    const next = !row.is_public
    setSending(next)
    fail('public', null)
    try {
      apply('is_public', await patch('public', `public:${next}`, { is_public: next }))
    } catch (e) {
      const read = unsure((e as Error).cause) ? await readRow() : null
      fail('public', (e as Error).message, String(read ? read.is_public : row.is_public))
    }
    setSending(null)
  })

  const putSlot = (position: number, userCardId: string) => guard('showcase', async () => {
    const r = await send<Mine>('showcase', `showcase:${position}:${userCardId}`, '/api/showcase', {
      method: 'PUT', body: JSON.stringify({ position, user_card_id: userCardId }),
    })
    setSlots(r.showcase)
    toast('Vitrine mise à jour.')
    // L'ajout disparaît avec le sélecteur : le focus va à « Changer » du même emplacement (son premier bouton).
    refocus.current = () => root.current?.querySelector<HTMLElement>(`[data-slot="${position}"] button`)
    setPicker(null)
  })
  const removeSlot = (position: number) => act('showcase', async () => {
    const r = await send<Mine>('showcase', `unshowcase:${position}`, '/api/showcase', { method: 'DELETE', body: JSON.stringify({ position }) })
    setSlots(r.showcase)
    toast('Carte retirée de la vitrine.')
    refocus.current = () => root.current?.querySelector<HTMLElement>(`[data-slot="${position}"] button`)
  })

  // « Réessayer » disparaît pendant la relecture : le focus attend sur le titre de sa section.
  const retry = (part: Part) => {
    const head = { avatar: avatarHead, bio: bioHead, public: publicHead, showcase: showcaseHead }[part]
    head.current?.focus()
    if (part === 'showcase') {
      setSlots(null)
      void readSlots()
    } else {
      setRow(null)
      void readRow()
    }
  }
  const rowState = (part: RowPart) => (row === null ? <Loading label="Chargement du profil" /> : <ReadError onRetry={() => retry(part)}>{ROW_FAILED}</ReadError>)

  return (
    <div ref={root} data-ready={row !== null && slots !== null ? '' : undefined} className="space-y-6">
      <PageHeader title={entry.title} icon={entry.icon}>
        {row && <Link href={`/profile/${encodeURIComponent(row.username)}`} className={ghost}>Voir comme les autres</Link>}
      </PageHeader>
      <div className="max-w-3xl space-y-6">
        <Section id={`${id}-avatar`} title="Avatar" ref={avatarHead}>
          {!row ? rowState('avatar') : (
            <>
              <div className="flex flex-wrap items-center gap-4">
                {/* Miniature Commons en lien direct, sans l'optimiseur de Next (D§8.5) ; décorative, alt vide (D:753). */}
                {row.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.avatar_url} alt="" className="size-24 shrink-0 rounded-full object-cover" />
                ) : (
                  <span aria-hidden="true" className="inline-flex size-24 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-light)] text-4xl font-bold text-[var(--color-accent)]">
                    {[...row.username][0]?.toUpperCase()}
                  </span>
                )}
                <div className="flex flex-wrap gap-3">
                  <button ref={changeAvatar} type="button" aria-disabled={busy.avatar || undefined} onClick={() => { if (!busy.avatar) setPicker({ mode: 'avatar' }) }} className={ghost}>
                    Changer l&apos;avatar
                  </button>
                  {row.avatar_url && (
                    <button type="button" aria-disabled={busy.avatar || undefined} onClick={() => void removeAvatar()} className={ghost}>Retirer l&apos;avatar</button>
                  )}
                </div>
              </div>
              {alert('avatar')}
            </>
          )}
        </Section>

        <Section id={`${id}-bio`} title="À propos" ref={bioHead}>
          {!row ? rowState('bio') : (
            <form onSubmit={saveBio} className="flex flex-col gap-3">
              <div className="space-y-1">
                <textarea
                  aria-labelledby={`${id}-bio`}
                  aria-describedby={`${id}-bio-count`}
                  value={bio}
                  maxLength={280}
                  rows={4}
                  readOnly={busy.bio}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setSaved('')
                    fail('bio', null)
                  }}
                  className="block w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm"
                />
                {/* value.length : unités UTF-16, plus strict que les caractères comptés par le serveur, jamais plus large. */}
                <p id={`${id}-bio-count`} className="text-right text-xs tabular-nums text-[var(--color-foreground)]/70">{`${formatInt(bio.length)} / 280`}</p>
              </div>
              {alert('bio')}
              <button type="submit" aria-disabled={bioOff || undefined} className={`${primary} self-start`}>Enregistrer</button>
              <p role="status" className="text-sm font-medium text-[var(--color-accent-light)]">{saved}</p>
            </form>
          )}
        </Section>

        <Section id={`${id}-public`} title="Visibilité" ref={publicHead}>
          {!row ? rowState('public') : (
            <>
              <div>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 font-medium">
                  <input
                    type="checkbox"
                    checked={sending ?? row.is_public}
                    aria-disabled={busy.public || undefined}
                    aria-describedby={`${id}-public-hint`}
                    onChange={() => void togglePublic()}
                    className="size-5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                  />
                  Profil public
                </label>
                <p id={`${id}-public-hint`} className={`${hint} pl-8`}>Décochée, seuls tes amis voient ta bio, ta vitrine et ta collection.</p>
              </div>
              {alert('public')}
            </>
          )}
        </Section>

        <Section id={`${id}-showcase`} title={slots ? `Vitrine (${formatInt(slots.length)}/4)` : 'Vitrine'} ref={showcaseHead}>
          {slots === null ? (
            <Loading label="Chargement de la vitrine" />
          ) : slots === false ? (
            <ReadError onRetry={() => retry('showcase')}>Impossible de charger cette page.</ReadError>
          ) : (
            <>
              <ul className="flex flex-wrap justify-center gap-3 sm:gap-[22px]">
                {[0, 1, 2, 3].map((position) => {
                  const s = slots.find((x) => x.position === position)
                  const desc = `${id}-slot-${position}`
                  return (
                    <li key={position} data-slot={position} className="flex flex-col items-center gap-2">
                      {s ? (
                        <>
                          <Card card={copyFace(s.user_card)} size="grid" count={s.user_card.count} isShiny={s.user_card.is_shiny} />
                          <span id={desc} className="sr-only">{s.user_card.card.wikipedia_title}</span>
                          <div className="flex flex-wrap justify-center gap-2">
                            <button type="button" aria-describedby={desc} aria-disabled={busy.showcase || undefined}
                              onClick={() => { if (!busy.showcase) setPicker({ mode: 'showcase', position }) }} className={ghost}>Changer</button>
                            <button type="button" aria-describedby={desc} aria-disabled={busy.showcase || undefined}
                              onClick={() => void removeSlot(position)} className={ghost}>Retirer</button>
                          </div>
                        </>
                      ) : (
                        <button
                          type="button"
                          aria-disabled={busy.showcase || undefined}
                          onClick={() => { if (!busy.showcase) setPicker({ mode: 'showcase', position }) }}
                          className={`${SIZES.grid.root} inline-flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--color-foreground)]/40 p-3 text-center text-sm font-medium transition-colors hover:bg-[var(--color-surface-light)]`}
                        >
                          <Plus aria-hidden="true" className="size-6 text-[var(--color-accent)]" />
                          {`Ajouter une carte à l'emplacement ${position + 1}`}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              {alert('showcase')}
            </>
          )}
        </Section>
      </div>

      {picker && (
        <CardPicker
          mode={picker.mode}
          onPick={(cid) => (picker.mode === 'avatar' ? pickAvatar(cid) : putSlot(picker.position, cid))}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
