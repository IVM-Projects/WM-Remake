import type { Metadata } from 'next'
import { navEntry } from '@/components/shell/nav'
import { ProfileEditor } from './profile-editor'

export const metadata: Metadata = { title: navEntry('/profile').title }

// Coquille statique ; la ligne du profil et la vitrine se lisent au client, section par section (ProfileEditor rend l'en-tête).
export default function ProfilePage() {
  return (
    <div className="flex-1 p-4 md:p-6 space-y-6">
      <ProfileEditor />
    </div>
  )
}
