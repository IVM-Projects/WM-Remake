import { notFound } from 'next/navigation'
import { Suspense, type ReactNode } from 'react'
import { AdminNav } from '@/components/admin/AdminNav'
import { Loading } from '@/components/ui/Loading'
import { staffRole } from '@/lib/staff'

// Pas de `metadata` ici : il serait rendu aussi pour un non-staff (G13) ; chaque page le pose, après la garde.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<Loading label="Chargement de l'administration" />}>
      <StaffGate>{children}</StaffGate>
    </Suspense>
  )
}

// Garde serveur : le rôle vient de wm.staff_me (SQL), jamais du client ; sans session, rôle ou avec une suspension/un bannissement actifs (G4) : 404.
async function StaffGate({ children }: { children: ReactNode }) {
  const role = await staffRole()
  if (!role) notFound()
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <AdminNav role={role} />
      {children}
    </div>
  )
}
