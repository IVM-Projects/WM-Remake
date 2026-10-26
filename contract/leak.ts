// Mesure d'une fuite (C23), pure : partagée par contract/spec/battles.ts et le parcours E2E du jalon (Task 15). Aucun import.

const FORBIDDEN = new Set(['correct_option_id', 'evidence', 'answer', 'q_index', 'correct'])

// Chemins (« battle.game_state.… », index de tableau compris) des clés interdites à toute profondeur ; `correct` n'est permis qu'au
// premier niveau d'une réponse à submit_single_answer (answerTop).
export function forbiddenKeys(body: unknown, answerTop: boolean): string[] {
  const found: string[] = []
  const walk = (v: unknown, path: string[]) => {
    if (v === null || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.has(k) && !(answerTop && k === 'correct' && path.length === 0)) found.push([...path, k].join('.'))
      walk(x, [...path, k])
    }
  }
  walk(body, [])
  return found
}

// n(text, id) de C23 pour chaque id, par `split` : un id préfixe d'un autre est compté aussi dans celui-ci (sans effet entre uuid).
export const idCounts = (text: string, ids: string[]): number[] => ids.map((id) => text.split(id).length - 1)
