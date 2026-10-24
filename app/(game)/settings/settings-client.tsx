'use client'

import { LogOut } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import { Field, FormError } from '@/components/auth/Field'
import { useHydrated } from '@/components/auth/Submit'
import { ghost as ghostBase } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { ReadError, Section } from '@/components/ui/Section'
import { api, ApiError, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { authErrorMessage, usernameProblem } from '@/lib/auth'
import { setPrefs } from '@/lib/prefs'
import { pushState, unsubscribePush } from '@/lib/push-browser'
import { createBrowserSupabase } from '@/lib/supabase/browser'
import { PushSection } from './push-section'

type Prefs = { sounds: boolean; hide_sensitive: boolean; is_public: boolean }
type Key = keyof Prefs

const TOGGLES: [Key, string, string][] = [
  ['sounds', 'Sons', 'Ouverture des paquets et révélation des cartes.'],
  ['hide_sensitive', 'Masquer les images sensibles', 'Une image signalée comme sensible laisse place à l\'emblème du jeu.'],
  ['is_public', 'Profil public', 'Décochée, seuls tes amis voient ta bio, ta vitrine et ta collection.'],
]

// Jamais disabled sur un bouton qui peut garder le focus : aria-disabled et une garde (le navigateur poserait le focus sur body).
const primary = 'inline-flex min-h-11 items-center justify-center self-start rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-foreground)] transition-colors hover:bg-[var(--color-accent-light)] aria-disabled:cursor-not-allowed aria-disabled:bg-[var(--color-surface-light)] aria-disabled:text-[var(--color-foreground)]/60 disabled:cursor-wait'
const ghost = `${ghostBase} justify-center gap-2 self-start`
const hint = 'text-sm text-[var(--color-foreground)]/70'
const ok = 'text-sm font-medium text-[var(--color-accent-light)]'

const dateFr = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' })
const nextChange = (iso: unknown) => (typeof iso === 'string' ? ` Prochain changement possible le ${dateFr.format(new Date(iso))}.` : '')

// Onglet « Général » (R§2.2) : profil, préférences, notifications, compte. Page jamais capturée (D§8.5) : chaque section a ses états
// de chargement, d'échec avec « Réessayer » et d'enregistrement ; une section en échec ne bloque pas les autres.
export function SettingsClient() {
  // null : en lecture ; false : lecture en échec.
  const [name, setName] = useState<string | null | false>(null)
  const [prefs, setPrefsView] = useState<Prefs | null | false>(null)
  const [prefError, setPrefError] = useState<string | null>(null)
  const [prefSaved, setPrefSaved] = useState('')
  const saving = useRef(new Set<Key>())
  // Valeurs confirmées par le serveur, qui seules partent vers le cache des cartes et des sons (setPrefs).
  const confirmed = useRef<Prefs | null>(null)
  // Une relecture partie avant un enregistrement n'écrase pas sa valeur.
  const prefsGen = useRef(0)

  const loadName = () => {
    const sb = createBrowserSupabase()
    sb.auth.getSession()
      .then(({ data: auth }) => sb.from('profiles').select('username').eq('id', auth.session?.user.id ?? '').maybeSingle())
      .then(({ data, error }) => setName(error || !data ? false : (data as { username: string }).username), () => setName(false))
  }
  const loadPrefs = () => {
    const g = prefsGen.current
    api<Prefs>('/api/settings/preferences').then(
      (p) => {
        if (g !== prefsGen.current) return
        confirmed.current = p
        setPrefs({ sounds: p.sounds, hideSensitive: p.hide_sensitive })
        setPrefsView(p)
      },
      () => { if (g === prefsGen.current) setPrefsView(false) },
    )
  }

  // À chaque affichage (Activity compris) : relu, sans repasser par le chargement.
  const onShow = useEffectEvent(() => {
    loadName()
    loadPrefs()
  })
  useEffect(() => {
    onShow()
  }, [])

  // « Réessayer » disparaît avec l'erreur : le focus attend sur le titre de la section.
  const retry = (heading: string, fn: () => void) => {
    document.getElementById(heading)?.focus()
    fn()
  }

  // Seule la clé k : la réponse d'un autre interrupteur, partie avant, n'écrase pas une valeur plus fraîche.
  const settle = (k: Key, v: boolean) => {
    confirmed.current = { ...(confirmed.current as Prefs), [k]: v }
    setPrefs({ sounds: confirmed.current.sounds, hideSensitive: confirmed.current.hide_sensitive })
  }

  // Refus, ou valeur que le serveur n'a pas retenue : le message connu. Issue inconnue (réseau, ≥ 500, 2xx illisible) : le texte du B12
  // et la valeur relue, comme « Profil public » de /profile.
  async function toggle(k: Key) {
    if (!prefs || !confirmed.current || saving.current.has(k)) return
    saving.current.add(k)
    prefsGen.current++
    const next = !prefs[k]
    setPrefsView((p) => p && { ...p, [k]: next })
    setPrefError(null)
    setPrefSaved('')
    try {
      const r = await api<Prefs | null>('/api/settings/preferences', { method: 'POST', body: JSON.stringify({ [k]: next }) })
      if (typeof r?.[k] !== 'boolean') throw new Error('Réponse illisible')
      settle(k, r[k])
      if (r[k] === next) setPrefSaved('Préférence enregistrée.')
      else setPrefError('Ta préférence n\'a pas pu être enregistrée.')
    } catch (e) {
      if (unsure(e)) {
        const p = await api<Prefs | null>('/api/settings/preferences').catch(() => null)
        if (typeof p?.[k] === 'boolean') settle(k, p[k])
      }
      setPrefError(unsure(e) ? UNSURE : 'Ta préférence n\'a pas pu être enregistrée.')
    }
    const now = confirmed.current[k]
    setPrefsView((p) => p && { ...p, [k]: now })
    // Une relecture partie pendant l'enregistrement est plus vieille que lui : elle ne s'appliquera pas.
    prefsGen.current++
    saving.current.delete(k)
  }

  return (
    <>
      <div role="tablist" aria-label="Paramètres" className="flex gap-1 border-b border-[var(--color-border)]">
        <button
          type="button"
          role="tab"
          id="settings-tab-general"
          aria-selected="true"
          aria-controls="settings-general"
          className="-mb-px inline-flex min-h-11 items-center border-b-2 border-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent)]"
        >
          Général
        </button>
      </div>
      <div role="tabpanel" id="settings-general" aria-labelledby="settings-tab-general" className="max-w-2xl space-y-6">
        <Section id="settings-profile" title="Profil">
          {name === null ? (
            <Loading label="Chargement du profil" />
          ) : name === false ? (
            <ReadError onRetry={() => retry('settings-profile', () => { setName(null); loadName() })}>Ton profil n&apos;a pas pu être chargé.</ReadError>
          ) : (
            <UsernameForm current={name} onSaved={setName} />
          )}
        </Section>

        <Section id="settings-prefs" title="Préférences">
          {prefs === null ? (
            <Loading label="Chargement des préférences" />
          ) : prefs === false ? (
            <ReadError onRetry={() => retry('settings-prefs', () => { setPrefsView(null); loadPrefs() })}>Tes préférences n&apos;ont pas pu être chargées.</ReadError>
          ) : (
            <>
              <ul className="space-y-4">
                {TOGGLES.map(([k, label, text]) => (
                  <li key={k}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 font-medium">
                      <input
                        type="checkbox"
                        name={k}
                        checked={prefs[k]}
                        onChange={() => void toggle(k)}
                        aria-describedby={`pref-${k}-hint`}
                        className="size-5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                      />
                      {label}
                    </label>
                    <p id={`pref-${k}-hint`} className={`${hint} pl-8`}>{text}</p>
                  </li>
                ))}
              </ul>
              {prefError && <FormError>{prefError}</FormError>}
            </>
          )}
          <p role="status" className={ok}>{prefSaved}</p>
        </Section>

        <PushSection />

        <Section id="settings-account" title="Compte">
          <PasswordForm />
          <div className="border-t border-[var(--color-border)] pt-4">
            <SignOut />
          </div>
        </Section>
      </div>
    </>
  )
}

function UsernameForm({ current, onSaved }: { current: string; onSaved: (username: string) => void }) {
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState('')
  const [pending, setPending] = useState(false)
  // Génération : une pré-vérification qui revient après une frappe ou un envoi est périmée.
  const gen = useRef(0)
  const hydrated = useHydrated()
  const off = pending || !value || value === current

  // Pré-vérification au départ du champ, comme l'inscription. Sautée quand seule la casse de son propre pseudo change :
  // la route anonyme ne sait pas exclure l'appelant et le dirait « déjà pris » ; le serveur tranche à l'envoi.
  function onBlur() {
    const u = value
    if (!u || u.toLowerCase() === current.toLowerCase()) return
    const g = ++gen.current
    // Réseau en échec : l'enregistrement vérifie de toute façon.
    // Un pseudo libre n'efface rien : la frappe efface déjà, et un refus du serveur (409) doit rester.
    void usernameProblem(u).catch(() => null).then((problem) => { if (problem && g === gen.current) setError(problem) })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (off) return
    gen.current++
    setPending(true)
    setError(null)
    setDone('')
    try {
      const r = await api<{ username: string; next_change_at: string }>('/api/settings/username', {
        method: 'POST',
        body: JSON.stringify({ username: value }),
      })
      onSaved(r.username)
      setDone(`Pseudo modifié.${nextChange(r.next_change_at)}`)
    } catch (err) {
      // Trop tôt : la date du prochain changement possible suit le message (409 username_change_too_soon).
      const at = err instanceof ApiError ? (err.body as { next_change_at?: unknown } | null)?.next_change_at : null
      setError(userMessage(err, 'Ton pseudo n\'a pas pu être modifié.') + nextChange(at))
    }
    setPending(false)
  }

  return (
    // noValidate : le serveur dit pourquoi un pseudo est refusé, en français (« Pseudo invalide (3 à 24 caractères) »).
    // method="post" en ceinture : même envoyé nativement, rien ne part dans l'adresse.
    <form method="post" onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Field
        id="settings-username"
        label="Pseudo"
        autoComplete="username"
        maxLength={24}
        value={value}
        error={error}
        aria-describedby={error ? 'settings-username-error settings-username-hint' : 'settings-username-hint'}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
          setDone('')
          gen.current++
        }}
        onBlur={onBlur}
      />
      <p id="settings-username-hint" className={hint}>3 à 24 caractères : lettres, chiffres, « _ », « . » ou « - ». Un changement tous les 30 jours.</p>
      {/* disabled jusqu'à l'hydratation seulement (aucun focus possible avant) ; ensuite aria-disabled et la garde de submit. */}
      <button type="submit" disabled={!hydrated} aria-disabled={off} className={primary}>Enregistrer le pseudo</button>
      <p role="status" className={ok}>{done}</p>
    </form>
  )
}

function PasswordForm() {
  const [mismatch, setMismatch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState('')
  const [pending, setPending] = useState(false)
  const hydrated = useHydrated()

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    const form = e.currentTarget
    const f = new FormData(form)
    const password = String(f.get('settings-password'))
    setError(null)
    setDone('')
    if (password !== String(f.get('settings-password-confirm'))) return setMismatch('Les deux mots de passe ne correspondent pas.')
    setMismatch(null)
    setPending(true)
    const { error } = await createBrowserSupabase().auth.updateUser({ password })
    setPending(false)
    if (error) return setError(authErrorMessage(error))
    form.reset()
    setDone('Mot de passe modifié.')
  }

  return (
    // Prérendu dans le HTML statique : bouton disabled tant que React n'a pas hydraté (Entrée ne soumet rien), et method="post" en ceinture.
    <form method="post" onSubmit={submit} className="flex flex-col gap-4">
      <Field id="settings-password" label="Nouveau mot de passe" type="password" autoComplete="new-password" minLength={6} />
      <Field
        id="settings-password-confirm"
        label="Confirme le nouveau mot de passe"
        type="password"
        autoComplete="new-password"
        minLength={6}
        error={mismatch}
        onChange={() => setMismatch(null)}
      />
      {error && <FormError>{error}</FormError>}
      <button type="submit" disabled={!hydrated} aria-disabled={pending} className={primary}>Changer le mot de passe</button>
      <p role="status" className={ok}>{done}</p>
    </form>
  )
}

function SignOut() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keys = useRef(new Map<string, string>())

  async function signOut() {
    if (pending) return
    setPending(true)
    setError(null)
    // Appareil désabonné d'abord, puis sa ligne (B18, PF12) : deux étapes indépendantes, le DELETE part même si le désabonnement du
    // navigateur échoue (navigateur partagé). Un échec ne bloque jamais la déconnexion : le renvoi de la section push rattachera
    // l'appareil au joueur suivant.
    const { sub } = await pushState().catch(() => ({ sub: null }))
    if (sub?.endpoint) {
      await unsubscribePush().catch(() => null)
      await apiOnce(keys.current, `unsubscribe:${sub.endpoint}`, '/api/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) })
        .catch(() => {})
    }
    const { error } = await createBrowserSupabase().auth.signOut()
    // Chargement complet : les pages gardées en mémoire (Activity) ne survivent pas à la session.
    if (!error) return window.location.replace('/login')
    setPending(false)
    setError('La déconnexion a échoué, réessaie.')
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" aria-disabled={pending} onClick={() => void signOut()} className={ghost}>
        <LogOut className="size-4" />
        Se déconnecter
      </button>
      {error && <FormError>{error}</FormError>}
    </div>
  )
}
