import type { NextConfig } from "next";
import { assertBrandSafe, BRAND_DEFAULT } from "./lib/brand.ts";

// Fail-closed : lu par `next build` et par `next start`.
assertBrandSafe(process.env.NEXT_PUBLIC_BRAND_NAME || BRAND_DEFAULT, process.env.DEMO_GATE_PASSWORD);

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
  redirects: async () => [{ source: "/pull", destination: "/pulls", permanent: true }],
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    },
  ],
};

export default nextConfig;
