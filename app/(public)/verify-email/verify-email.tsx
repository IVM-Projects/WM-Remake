'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { linkClass } from '@/components/auth/Field'
import { OtpForm } from '@/components/auth/OtpForm'

export function VerifyEmail() {
  const router = useRouter()
  const email = useSearchParams().get('email')
  if (!email) {
    return (
      <p className="text-sm text-foreground/70">
        Adresse inconnue : <Link href="/login" className={linkClass}>Se connecter</Link> ou{' '}
        <Link href="/signup" className={linkClass}>Créer un compte</Link>
      </p>
    )
  }
  return <OtpForm email={email} onVerified={() => router.replace('/pulls')} />
}
