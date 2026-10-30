import type { NextConfig } from "next";
import { assertBrandSafe, brand } from "./lib/brand.ts";
import { gateEnv } from "./lib/gate.ts";

// Fail-closed : lu par `next build` et par `next start` ; gateEnv() lève aussi si la porte est à moitié configurée.
assertBrandSafe(brand.name, gateEnv()?.password);

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Profils du marché (M3-22, lib/market-cache.ts) : expire doit dépasser revalidate, stale ne descend pas sous 30 s (cacheLife.md).
  // market : jamais servie au-delà de 3 s (D§8.4) ; auction sert aussi aux codes occupés rendus (P10).
  cacheLife: {
    market: { stale: 30, revalidate: 2, expire: 3 },
    auction: { stale: 30, revalidate: 1, expire: 2 },
    sales: { stale: 30, revalidate: 60, expire: 120 },
    // Classements (G11, lib/leaderboard-cache.ts) : guildes 30 s, joueurs 60 s (rendus au plus 120 s).
    guilds: { stale: 30, revalidate: 30, expire: 60 },
    players: { stale: 30, revalidate: 60, expire: 120 },
  },
  partialPrefetching: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        // Démo privée : tout en noindex (D§3.4), porte ou non ; proxy.ts le pose aussi sur ses propres réponses.
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      ],
    },
  ],
};

export default nextConfig;
