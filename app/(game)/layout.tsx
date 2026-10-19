import type { ReactNode } from 'react'
import { Bell } from '@/components/shell/Bell'
import { BottomBar } from '@/components/shell/BottomBar'
import { Logo } from '@/components/shell/Logo'
import { Sidebar } from '@/components/shell/Sidebar'

// Shell R§6.3 / D§8.5 : body > div.flex.h-dvh, la nav d'abord, puis main qui défile (jamais body).
// Le logo (h1) et la cloche vivent dans un en-tête hors de la nav et de main : `nav.hidden a` ne compte que les 13 entrées, `main h1` est le titre de page.
export default function GameLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-1.5 md:px-6">
          <Logo />
          <Bell />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <BottomBar />
    </div>
  )
}
