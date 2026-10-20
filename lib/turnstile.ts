const CLOUDFLARE = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

// Vérification Turnstile côté serveur (D§7.1) : secret absent, réseau, statut ou corps inattendu → refus.
export async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return false
  try {
    const res = await fetch(process.env.TURNSTILE_VERIFY_URL || CLOUDFLARE, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, ...(ip && { remoteip: ip }) }),
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok && ((await res.json()) as { success?: unknown }).success === true
  } catch {
    return false
  }
}
