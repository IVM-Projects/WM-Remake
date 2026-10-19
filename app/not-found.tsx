import type { Metadata } from "next";
import Link from "next/link";

// Servie aussi devant la porte (chemins exemptés inconnus) : titre absolu, sans la marque.
export const metadata: Metadata = { title: { absolute: "Page introuvable" } };

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4 text-center animate-fade-in-up">
      <h1 className="text-2xl font-bold md:text-3xl">Page introuvable</h1>
      <Link
        href="/pulls"
        className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-light"
      >
        Retour aux paquets
      </Link>
    </main>
  );
}
