// `node scripts/check-dml.ts` : DELETE/UPDATE sans WHERE dans supabase/migrations/*.sql, refusés par pg-safeupdate sur la base hébergée.
// Rien sur stdout : db-test.sh --setup-only n'y imprime que sa ligne DATABASE_URL=.
import { readdirSync, readFileSync } from 'node:fs'

// shortcut: découpe naïve sur `;` (chaînes et commentaires /* */ non lus), un WHERE de sous-requête garde l'instruction ; un vrai parseur si un faux positif gêne.
export function unguardedDml(sql: string): string[] {
  return sql.replace(/--.*$/gm, '').split(';').flatMap((s) => {
    const m = /\b(delete\s+from|update\s+\S+(\s+(as\s+)?\w+)?\s+set)\b/i.exec(s)
    const stmt = m ? s.slice(m.index).trim().replace(/\s+/g, ' ') : ''
    return stmt && !/\bwhere\b/i.test(stmt) ? [stmt] : []
  })
}

if (import.meta.main) {
  const dir = new URL('../supabase/migrations/', import.meta.url)
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const s of unguardedDml(readFileSync(new URL(f, dir), 'utf8'))) {
      console.error(`${f} : ${s}`)
      process.exitCode = 1
    }
  }
}
