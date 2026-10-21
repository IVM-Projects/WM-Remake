// `node scripts/check-dml.ts [dossier]` : DELETE/UPDATE sans WHERE dans <dossier>/*.sql (supabase/migrations par défaut), refusés par
// pg-safeupdate sur la base hébergée. Rien sur stdout : db-test.sh --setup-only n'y imprime que sa ligne DATABASE_URL=.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DML = /\b(delete\s+from|update\s+\S+(\s+(as\s+)?\w+)?\s+set)\b/gi

// Chaque DELETE/UPDATE d'une instruction n'est gardé que par un WHERE situé avant le DML suivant (CTE d'écriture comprises).
// shortcut: découpe sur `;` sans lire les chaînes ni les commentaires /* */, et un WHERE de sous-requête garde le DML ; un vrai parseur si un faux positif ou négatif gêne.
export function unguardedDml(sql: string): string[] {
  return sql.replace(/--.*$/gm, '').split(';').flatMap((s) => {
    const at = [...s.matchAll(DML)].map((m) => m.index)
    return at.map((a, i) => s.slice(a, at[i + 1]).trim().replace(/\s+/g, ' ')).filter((t) => !/\bwhere\b/i.test(t))
  })
}

if (import.meta.main) {
  const dir = process.argv[2] ?? fileURLToPath(new URL('../supabase/migrations/', import.meta.url))
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const s of unguardedDml(readFileSync(join(dir, f), 'utf8'))) {
      console.error(`${f} : ${s}`)
      process.exitCode = 1
    }
  }
}
