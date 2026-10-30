'use client'

import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { Card } from '@/components/card/Card'
import { ghost, primary } from '@/components/ui/button'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { ReadError, Section } from '@/components/ui/Section'
import { toast } from '@/components/ui/toast'
import { api, ApiError, apiOnce, UNSURE, unsure, userMessage } from '@/lib/api'
import { formatInt } from '@/lib/format'
import { CatalogPicker } from './CatalogPicker'
import { isNoGuild, type GuildHome, type Wish } from './types'

const readable = (r: GuildHome | null): GuildHome | null =>
  (r && 'my_wishlist' in r && Array.isArray(r.wishlists) && Array.isArray(r.weekly_karma_donors) ? r : null)
const fail = (e: unknown) => (unsure(e) ? UNSURE : userMessage(e, 'L\'action n\'a pas abouti.'))
// Où le focus va quand l'élément qui le tenait disparaît à la relecture : « Retirer ma demande » (demande posée), « Demander une carte »
// (demande retirée), le « Donner » du souhait qui prend le rang du souhait donné.
type Target = 'clear' | 'ask' | { donate: number }

// Onglet « Entraide » : ma demande (une seule, PUT la remplace), les demandes des autres (don d'une copie choisie) et les donneurs de la semaine.
// onLost : un 404 « aucune guilde » ; onTab : l'onglet, cible du focus de « Réessayer ».
export function GuildHelp({ onLost, onTab }: { onLost: () => void; onTab: () => void }) {
  const id = useId()
  const [home, setHome] = useState<GuildHome | null>(null)
  const [failed, setFailed] = useState(false)
  const [asking, setAsking] = useState(false)
  const [donating, setDonating] = useState<Wish | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const gen = useRef(0)
  const after = useRef<Target | 'tab' | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const empty = useRef<HTMLParagraphElement>(null)
  const ask = useRef<HTMLButtonElement>(null)
  const clearButton = useRef<HTMLButtonElement>(null)

  // Lectures ordonnées : seule la dernière partie s'applique. Un échec garde l'entraide affichée ; sans elle, « Réessayer ».
  const read = (): Promise<void> => {
    const g = ++gen.current
    return api<GuildHome | null>('/api/guilds/home').then(readable, (e) => {
      if (isNoGuild(e)) onLost()
      return null
    }).then((r) => {
      if (g !== gen.current) return
      if (r) setHome(r)
      setFailed(!r)
    })
  }
  const onMount = useEffectEvent(() => void read())
  useEffect(() => onMount(), [])

  const refocus = useEffectEvent(() => {
    const t = after.current
    if (!t || (!home && !failed)) return
    after.current = null
    if (document.activeElement !== document.body) return
    if (t === 'tab') return onTab()
    if (t === 'clear') return clearButton.current?.focus()
    if (t === 'ask') return ask.current?.focus()
    const donates = list.current?.querySelectorAll<HTMLElement>('[data-donate]')
    ;(donates?.length ? donates[Math.min(t.donate, donates.length - 1)] : empty.current)?.focus()
  })
  useEffect(() => refocus(), [home, failed])

  async function pick(cardId: string, title: string) {
    try {
      await apiOnce(keys.current, `wish:${cardId}`, '/api/guilds/wishlist', { method: 'PUT', body: JSON.stringify({ card_id: cardId }) })
    } catch (e) {
      if (isNoGuild(e)) {
        setAsking(false)
        return onLost()
      }
      throw new Error(fail(e))
    }
    toast(`Demande enregistrée : ${title}.`)
    after.current = 'clear'
    setAsking(false)
    void read()
  }

  async function clear() {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      await apiOnce(keys.current, 'clear', '/api/guilds/wishlist', { method: 'DELETE' })
      after.current = 'ask'
    } catch (e) {
      if (isNoGuild(e)) return void onLost()
      // « Tu ne demandes aucune carte » : déjà retirée ailleurs, la relecture le montre.
      if (e instanceof ApiError && e.status === 404) after.current = 'ask'
      else setError(fail(e))
    } finally {
      inflight.current = false
      setBusy(false)
    }
    void read()
  }

  if (!home) return failed ? <ReadError onRetry={() => { after.current = 'tab'; setFailed(false); void read() }}>L&apos;entraide n&apos;a pas pu être chargée.</ReadError> : <Loading label="Chargement de l'entraide" />
  const mine = home.my_wishlist
  return (
    <div className="space-y-4">
      <Section id={`${id}-mine`} title="Ma demande">
        {mine ? (
          <div className="space-y-3">
            <Card card={mine.card} size="grid" />
            <button ref={clearButton} type="button" aria-disabled={busy || undefined} onClick={() => void clear()} className={ghost}>Retirer ma demande</button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">Tu ne demandes aucune carte.</p>
            <button ref={ask} type="button" aria-haspopup="dialog" onClick={() => { setError(null); setAsking(true) }} className={primary}>Demander une carte</button>
          </div>
        )}
        {home.received_donation_today && <p className="text-sm font-medium">Tu as reçu un don aujourd&apos;hui.</p>}
        {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      </Section>

      <Section id={`${id}-wishes`} title="Demandes de la guilde">
        {home.wishlists.length ? (
          <ul ref={list} className="flex flex-wrap gap-4">
            {home.wishlists.map((w) => {
              const why = `${id}-why-${w.id}`
              const reason = !w.my_copies.length ? 'Tu n\'as pas de copie libre de cette carte.' : w.recipient_received_today ? `${w.user.username} a déjà reçu un don aujourd'hui.` : null
              return (
                <li key={w.id} className="flex min-w-0 flex-col items-start gap-2">
                  <Card card={w.card} size="grid" />
                  <p className="max-w-40 text-sm wrap-anywhere">{`Demandée par ${w.user.username}`}</p>
                  <button
                    type="button"
                    data-donate=""
                    aria-haspopup="dialog"
                    aria-disabled={reason ? true : undefined}
                    aria-describedby={reason ? why : undefined}
                    onClick={() => { if (!reason) setDonating(w) }}
                    className={primary}
                  >
                    Donner
                  </button>
                  {reason && <span id={why} className="sr-only">{reason}</span>}
                </li>
              )
            })}
          </ul>
        ) : (
          <p ref={empty} tabIndex={-1} className="text-sm outline-none">Aucune demande dans la guilde.</p>
        )}
      </Section>

      <Section id={`${id}-donors`} title="Entraide de la semaine">
        {home.weekly_karma_donors.length ? (
          <ol className="space-y-1 text-sm">
            {home.weekly_karma_donors.map((d) => (
              <li key={d.user_id} className="wrap-anywhere">{`${d.username} — ${formatInt(d.donations_this_week)} ${d.donations_this_week > 1 ? 'dons' : 'don'}`}</li>
            ))}
          </ol>
        ) : (
          <p className="text-sm">Aucun don cette semaine.</p>
        )}
      </Section>

      {asking && <CatalogPicker onPick={pick} onClose={() => setAsking(false)} />}
      {donating && (
        <DonateDialog
          wish={donating}
          onClose={() => setDonating(null)}
          onLost={() => { setDonating(null); onLost() }}
          onRead={() => void read()}
          onDone={() => {
            after.current = { donate: Math.max(0, home.wishlists.findIndex((w) => w.id === donating.id)) }
            setDonating(null)
            void read()
          }}
        />
      )}
    </div>
  )
}

// « Donner » : choix de la copie (la première cochée), puis le don. Refus : son texte ; issue incertaine : UNSURE, clé gardée (apiOnce),
// relecture ; le renvoi rejoue la réponse stockée.
function DonateDialog({ wish, onClose, onLost, onRead, onDone }: { wish: Wish; onClose: () => void; onLost: () => void; onRead: () => void; onDone: () => void }) {
  const id = useId()
  const [copy, setCopy] = useState(wish.my_copies[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const keys = useRef(new Map<string, string>())
  const who = wish.user.username

  async function give() {
    if (inflight.current || !copy) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      await apiOnce(keys.current, `donate:${wish.id}:${copy}`, '/api/guilds/wishlist/donate',
        { method: 'POST', body: JSON.stringify({ wishlist_id: wish.id, user_card_id: copy }) })
      toast(`Don envoyé à ${who} : +1 point de karma.`)
      onDone()
    } catch (e) {
      if (isNoGuild(e)) return void onLost()
      setError(fail(e))
      onRead()
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }
  const close = () => {
    if (!inflight.current) onClose()
  }

  return (
    <Modal onClose={close} labelledBy={`${id}-title`} className="card-frame relative w-full max-w-md max-h-[90vh] animate-fade-in-up space-y-4 overflow-y-auto p-6">
      <h2 id={`${id}-title`} className="text-xl font-bold wrap-anywhere">{`Donner ${wish.card.wikipedia_title} à ${who} ?`}</h2>
      {wish.my_copies.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold">Copie à donner</legend>
          {wish.my_copies.map((c) => (
            <label key={c.id} className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="radio"
                name={`${id}-copy`}
                value={c.id}
                checked={copy === c.id}
                // Garde pendant l'envoi : une radio n'a pas de readOnly. Une autre copie est une autre intention (sa clé propre).
                onChange={() => { if (!inflight.current) setCopy(c.id) }}
                className="size-5 accent-[var(--color-accent)]"
              />
              {`Copie ×${formatInt(c.count)}${c.is_shiny ? ', brillante' : ''}`}
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-sm">Si cette copie est dans ta vitrine ou ton avatar, elle en sort.</p>
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" aria-disabled={busy || undefined} onClick={close} className={ghost}>Annuler</button>
        <button type="button" aria-disabled={busy || undefined} onClick={() => void give()} className={primary}>Donner</button>
      </div>
    </Modal>
  )
}
