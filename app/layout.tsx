import type { Metadata } from "next";
import localFont from "next/font/local";
import { brand } from "@/lib/brand";
import "./globals.css";

// Fichiers @fontsource-variable 5.3.0 (OFL, app/fonts/OFL.txt) : next/font/google télécharge au build.
// Le dernier fichier listé est essayé en premier et sert aux métriques du repli.
// shortcut: next/font/local ne pose pas d'unicode-range par fichier, donc latin-ext se télécharge aussi ; passer à un appel par sous-ensemble (declarations font-family + unicode-range) si son poids compte.
const rubik = localFont({
  src: [{ path: "./fonts/rubik-latin-ext-wght-normal.woff2" }, { path: "./fonts/rubik-latin-wght-normal.woff2" }],
  weight: "300 900",
  variable: "--font-heading",
});

const inter = localFont({
  src: [{ path: "./fonts/inter-latin-ext-wght-normal.woff2" }, { path: "./fonts/inter-latin-wght-normal.woff2" }],
  weight: "100 900",
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: { default: brand.name, template: `%s — ${brand.name}` },
  robots: process.env.DEMO_GATE_PASSWORD ? { index: false, follow: false } : undefined,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={`dark ${rubik.variable} ${inter.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
