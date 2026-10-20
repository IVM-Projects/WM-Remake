'use client'

import { X } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { createBrowserSupabase } from '@/lib/supabase/browser'

export type Tag = { id: string; name: string; color: string | null }

type Props = { userCardId: string; tags: Tag[]; onChange: (tags: Tag[]) => void }

// Noir ou blanc, le plus contrasté sur la couleur de l'étiquette : le meilleur des deux dépasse toujours 4,58:1.
export function inkOn(hex: string): 'black' | 'white' {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05
  return l / 0.05 >= 1.05 / l ? 'black' : 'white'
}

const byName = (a: Tag, b: Tag) => a.name.localeCompare(b.name, 'fr')

// Étiquettes d'une copie (R§6.5), lues et écrites en direct par PostgREST sous RLS (D§7.3).
// DOM du contrat : input[placeholder="Ajouter une étiquette…"], [role=listbox] li[role=option] button, « Retirer l'étiquette X ».
export function TagPicker({ userCardId, tags, onChange }: Props) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [mine, setMine] = useState<Tag[] | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = q.trim()
  const lower = name.toLowerCase()
  const exact = mine?.find((t) => t.name.toLowerCase() === lower)
  const options: (Tag | null)[] = (mine ?? []).filter((t) => !tags.some((x) => x.id === t.id) && t.name.toLowerCase().includes(lower))
  if (name && !exact) options.push(null) // null : créer l'étiquette « name »
  const expanded = open && options.length > 0

  async function load() {
    if (mine) return
    const { data } = await createBrowserSupabase().from('tags').select('id,name,color').order('name')
    setMine(data ?? [])
  }

  async function add(choice: Tag | null | undefined) {
    if (busy || (!choice && !name)) return
    const sb = createBrowserSupabase()
    setBusy(true)
    setError(null)
    try {
      let tag = choice ?? exact
      if (!tag) {
        const { data: auth } = await sb.auth.getSession()
        const res = await sb.from('tags').insert({ user_id: auth.session?.user.id, name, color: null }).select('id,name,color').single()
        // 23505 : créée entre-temps (autre onglet) ; on reprend celle-là.
        const row = res.error?.code === '23505' ? (await sb.from('tags').select('id,name,color').eq('name', name).single()).data : res.data
        if (!row) throw res.error
        tag = row as Tag
        setMine((m) => [...(m ?? []), row as Tag].sort(byName))
      }
      const link = await sb.from('user_card_tags').insert({ user_card_id: userCardId, tag_id: tag.id })
      if (link.error && link.error.code !== '23505') throw link.error
      onChange([...tags.filter((t) => t.id !== tag.id), tag].sort(byName))
      setQ('')
      setActive(0)
    } catch {
      setError('L\'étiquette n\'a pas pu être ajoutée.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(tag: Tag) {
    const { error } = await createBrowserSupabase().from('user_card_tags').delete().eq('user_card_id', userCardId).eq('tag_id', tag.id)
    if (error) return setError('L\'étiquette n\'a pas pu être retirée.')
    setError(null)
    onChange(tags.filter((t) => t.id !== tag.id))
    // Le bouton cliqué disparaît : le focus reste dans la modale.
    input.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.max(0, Math.min(options.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void add(expanded ? options[active] : undefined)
    } else if (e.key === 'Escape' && expanded) {
      // Échap ferme d'abord la liste, la modale ensuite.
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <li key={t.id} className="min-w-0 max-w-full">
              <span
                className={`inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-2.5 pr-0.5 text-xs font-semibold ${t.color ? '' : 'border border-[var(--color-border)] bg-[var(--color-surface-light)]'}`}
                style={t.color ? { backgroundColor: t.color, color: inkOn(t.color) } : undefined}
              >
                {/* 48 caractères au plus : tronqué à l'écran, entier dans le DOM. */}
                <span className="truncate" title={t.name}>#{t.name}</span>
                <button
                  type="button"
                  aria-label={`Retirer l'étiquette ${t.name}`}
                  onClick={() => void remove(t)}
                  // Anneau dans l'encre de la puce : l'émeraude disparaîtrait sur une étiquette émeraude.
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-black/15 focus-visible:outline-current focus-visible:-outline-offset-2"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="Ajouter une étiquette"
          aria-expanded={expanded}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? `${id}-opt-${active}` : undefined}
          placeholder="Ajouter une étiquette…"
          maxLength={48}
          value={q}
          // Jamais disabled pendant l'écriture : le champ perdrait le focus, qui sortirait de la modale.
          aria-busy={busy}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={() => {
            setOpen(true)
            void load()
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="w-full rounded-xl border border-[var(--color-foreground)]/40 bg-[var(--color-surface-light)] px-3 py-2.5 text-sm placeholder:text-[var(--color-foreground)]/60"
        />
        {expanded && (
          <ul
            role="listbox"
            id={`${id}-list`}
            aria-label="Étiquettes"
            // Garder le focus dans le champ : le clic choisit sans fermer la liste avant.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-light)] p-1"
          >
            {options.map((t, i) => (
              <li key={t?.id ?? 'new'} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}>
                {/* Hors tabulation : le clavier passe par les flèches du champ (aria-activedescendant). */}
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => void add(t)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${i === active ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent-light)]' : ''}`}
                >
                  {t ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full border border-[var(--color-foreground)]/30"
                        style={t.color ? { backgroundColor: t.color } : undefined}
                      />
                      <span className="truncate">{t.name}</span>
                    </>
                  ) : (
                    <span className="truncate">Créer « {name} »</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
