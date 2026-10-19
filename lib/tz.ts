// Fuseau IANA du client (x-wiki-calendar-tz) ; tout ce qu'Intl refuse retombe sur Europe/Paris.
export function resolveTz(header: string | null): string {
  // Décalages (« +05:00 ») refusés : Intl les accepte, mais Postgres les lit en POSIX, signe inversé.
  if (!header || header.length > 64 || /^[+-]/.test(header)) return 'Europe/Paris'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: header })
    return header
  } catch {
    return 'Europe/Paris'
  }
}
