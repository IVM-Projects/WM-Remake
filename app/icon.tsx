import { ImageResponse } from "next/og";
import { brand } from "@/lib/brand";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const initials = (brand.prefix ? brand.prefix[0] + (brand.rest[0] ?? "") : brand.name[0]).toUpperCase();

// Satori ne lit pas les variables CSS : --color-accent sur --color-background, en dur.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0d0d0d",
          color: "#34d399",
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: -1,
        }}
      >
        {initials}
      </div>
    ),
    size,
  );
}
