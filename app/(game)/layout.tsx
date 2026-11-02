import type { ReactNode } from 'react'
import { Balance } from '@/components/shell/Balance'
import { Bell } from '@/components/shell/Bell'
import { BottomBar } from '@/components/shell/BottomBar'
import { Footer } from '@/components/shell/Footer'
import { Logo } from '@/components/shell/Logo'
import { Sidebar } from '@/components/shell/Sidebar'
import { ShopProvider } from '@/components/shop/ShopProvider'

// Shell R§6.3 / D§8.5 : body > div.flex.h-dvh, la nav d'abord, puis main qui défile (jamais body).
// Le logo (h1), le solde et la cloche vivent dans un en-tête hors de la nav et de main : `nav.hidden a` ne compte que les 13 entrées, `main h1` est le titre de page.
export default function GameLayout({ children }: { children: ReactNode }) {
  return (
    <ShopProvider>
      <div className="flex h-dvh flex-col md:flex-row">
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-1.5 sm:gap-4 md:px-6">
            <Logo />
            <div className="flex items-center gap-1 sm:gap-2">
              <Balance />
              <Bell />
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            {children}
            <Footer />
          </main>
        </div>
        <BottomBar />
      </div>
    </ShopProvider>
  )
}
