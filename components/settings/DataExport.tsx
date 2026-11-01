'use client'

import { useRef, useState } from 'react'
import { primary } from '@/components/ui/button'
import { Section } from '@/components/ui/Section'
import { toast } from '@/components/ui/toast'
import { ApiError } from '@/lib/api'
import { brand } from '@/lib/brand'

const FAIL = 'L\'export n\'a pas pu être préparé, réessaie.'
// Date locale AAAA-MM-JJ (pas toISOString, qui est en UTC).
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// « Mes données » (G10) : export JSON téléchargé côté navigateur ; le serveur limite le débit (429, texte affiché tel quel).
export function DataExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)

  async function download() {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/export')
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null)
        const text = (body as { error?: unknown; message?: unknown } | null)?.error ?? (body as { message?: unknown } | null)?.message
        // Refus net (< 500) : le texte du serveur ; sinon l'échec générique.
        throw res.status < 500 && typeof text === 'string' ? new ApiError(res.status, body) : new Error(FAIL)
      }
      // Un 200 illisible n'est pas un export : on refuse de le sauvegarder.
      const blob = new Blob([JSON.stringify(await res.json())], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${brand.name.toLowerCase()}-export-${day()}.json`
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      toast('Export téléchargé.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : FAIL)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  return (
    <Section id="settings-data" title="Mes données">
      <p className="text-sm text-[var(--color-foreground)]/70">
        Télécharge une copie de toutes tes données : profil, collection, grand livre des wikibidous, échanges, enchères, batailles, messages, amis, guilde et succès.
      </p>
      <button type="button" aria-disabled={busy} onClick={() => void download()} className={`${primary} justify-center`}>Télécharger mes données</button>
      <p role="status" className="text-sm text-[var(--color-foreground)]/70">{busy ? 'Préparation de l\'export…' : ''}</p>
      {error && <p role="alert" className="text-sm font-medium text-red-400">{error}</p>}
    </Section>
  )
}
