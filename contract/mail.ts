// Boîte Mailpit du banc (harness.ts) : dernier e-mail reçu par une adresse, code et lien qu'il contient.
import { setTimeout as sleep } from 'node:timers/promises'
import { MAILPIT_URL } from './harness.ts'

export async function latestMail(email: string): Promise<{ subject: string; text: string; html: string }> {
  const deadline = Date.now() + 10_000
  for (;;) {
    // Mailpit trie du plus récent au plus ancien.
    const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    const { messages } = (await search.json()) as { messages: { ID: string }[] }
    if (messages.length) {
      const mail = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`)).json()) as { Subject: string; Text: string; HTML: string }
      return { subject: mail.Subject, text: mail.Text, html: mail.HTML }
    }
    if (Date.now() > deadline) throw new Error(`aucun e-mail pour ${email} en 10 s`)
    await sleep(200)
  }
}

export async function latestOtp(email: string): Promise<string> {
  const { text } = await latestMail(email)
  const otp = /\b(\d{6})\b/.exec(text)?.[1]
  if (!otp) throw new Error(`aucun code à 6 chiffres dans le dernier e-mail de ${email}`)
  return otp
}

export async function latestLink(email: string): Promise<string> {
  const { html } = await latestMail(email)
  const href = /href="([^"]+)"/.exec(html)?.[1]
  if (!href) throw new Error(`aucun lien dans le dernier e-mail de ${email}`)
  return href.replaceAll('&amp;', '&') // attribut HTML échappé
}
