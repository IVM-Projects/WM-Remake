import type { NextConfig } from "next";
import { assertBrandSafe, brand } from "./lib/brand.ts";
import { gateEnv } from "./lib/gate.ts";

// Fail-closed : lu par `next build` et par `next start` ; gateEnv() lève aussi si la porte est à moitié configurée.
assertBrandSafe(brand.name, gateEnv()?.password);

const nextConfig: NextConfig = {
  cacheComponents: true,
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
