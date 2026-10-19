import Link from 'next/link'
import { Logo } from '@/components/shell/Logo'

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4 text-center motion-safe:animate-fade-in-up">
      <Logo />
      <p className="max-w-md text-balance text-[var(--color-foreground)]/80">
        Chaque article de Wikipédia peut devenir une carte&nbsp;: ouvre des paquets, garnis ta collection et échange tes doublons.
      </p>
      <div className="flex w-full max-w-xs flex-col gap-3 sm:max-w-none sm:w-auto sm:flex-row">
        <Link
          href="/signup"
          className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-light"
        >
          Créer un compte
        </Link>
        <Link
          href="/login"
          className="rounded-xl border border-[var(--color-foreground)]/50 px-4 py-3 text-sm font-semibold transition-colors hover:bg-[var(--color-surface-light)]"
        >
          Se connecter
        </Link>
      </div>
    </main>
  )
}
