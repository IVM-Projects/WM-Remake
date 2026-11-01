'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

// Lien « Administration » du pied de page, pour le staff seulement (G14). Le rôle vient du serveur ; une erreur ne montre rien.
export function StaffLink() {
  const [staff, setStaff] = useState(false)
  useEffect(() => {
    let live = true
    api<{ role?: unknown }>('/api/admin/me').then((r) => { if (live && r?.role) setStaff(true) }, () => {})
    return () => { live = false }
  }, [])
  if (!staff) return null
  return (
    <span>
      {' '}·{' '}
      <Link href="/admin" className="inline-flex min-h-11 items-center font-medium text-accent underline hover:text-accent-light">Administration</Link>
    </span>
  )
}
