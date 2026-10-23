import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Loading } from '@/components/ui/Loading'
import { ProfileView } from './profile-view'

// Titre statique (M4b-24) : le pseudo n'est connu que du client (B13, aucun titre de document au pseudo).
export const metadata: Metadata = { title: 'Profil' }

// useParams suspend sans generateStaticParams (dynamic-routes.md) : la coquille prefetchée n'a que ce repli, sans lecture.
// Sans key : chaque pseudo a sa propre instance sous Activity (clé de segment username|<valeur>|d), qui fige son pseudo au montage.
export default function PublicProfilePage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <Suspense fallback={<Loading label="Chargement du profil" />}>
        <ProfileView />
      </Suspense>
    </div>
  )
}
