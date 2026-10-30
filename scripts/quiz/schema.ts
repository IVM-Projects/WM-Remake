// Banques générées : normalisation partagée avec wm.quiz_norm (C20) et validation question par question. Chaque règle de
// wm.quiz_check_one (1910_wm_quiz_templates.sql) est reprise ici, au moins aussi stricte, pour que wm.quiz_store, qui reste la barrière,
// ne refuse pas une banque gardée. Lu aussi par node (generate.ts, fake-upstream.ts) : imports relatifs en .ts seulement.
import { z } from 'zod'

export type Question = { prompt: string; options: string[]; correct: number; evidence: string }
// json : réponse amont qui ne s'analyse pas ; store : refus de wm.quiz_store (C20). Ordre des départages de generate.ts (C12).
export const RULES = ['json', 'shape', 'lengths', 'distinct', 'evidence_source', 'answer_in_evidence', 'distractor_in_evidence',
  'answer_in_prompt', 'title', 'forbidden', 'duplicate', 'store'] as const
export type Rule = (typeof RULES)[number]

// C20 : œ → oe, æ → ae, sans diacritiques, minuscules, toute suite hors lettres et chiffres → une espace.
export const norm = (s: string): string => s.toLowerCase().replaceAll('œ', 'oe').replaceAll('æ', 'ae').normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Texte que jsonb accepte : ni U+0000 ni surrogate isolé (PostgreSQL refuserait l'appel de quiz_store en citant la question à son journal).
const Str = z.string().refine((s) => s.isWellFormed() && !s.includes('\u0000'))
// z.object retire les clés en plus : quiz_store ajoute kind et refuse toute autre clé.
const Shape = z.object({ prompt: Str, options: z.array(Str).length(4), correct: z.int().min(0).max(3), evidence: Str })
// Longueurs en caractères, comme char_length.
const len = (s: string) => [...s].length
const LINK = /https?:\/\/|www\.|@/i
// Couvre le catch_all de quiz_check_one (« toutes ces réponses », « aucune »…).
const CATCH_ALL = /^(toutes|aucune)\b/
const OFF_TOPIC = /\b(vues|consult\w*|rarete|statistiques?)\b/
const STOP = new Set(['les', 'des', 'une', 'aux', 'par', 'pour', 'dans', 'sur', 'avec', 'sans', 'sous', 'est', 'sont', 'qui', 'que', 'quoi',
  'quel', 'quelle', 'quels', 'quelles', 'dont', 'cette', 'ces', 'son', 'ses', 'leur', 'leurs', 'elle', 'elles', 'ils', 'mais', 'donc',
  'car', 'comme', 'plus', 'moins', 'tres', 'tout', 'tous', 'toute', 'toutes', 'lequel', 'laquelle', 'lesquels', 'lesquelles'])
const fullWords = (s: string) => s.split(' ').filter((w) => w.length >= 3 && !STOP.has(w)).length
function jaccard(a: string, b: string): number {
  const x = new Set(a.split(' '))
  const y = new Set(b.split(' '))
  const both = [...x].filter((w) => y.has(w)).length
  return both / (x.size + y.size - both)
}

// Question par question, dans l'ordre des règles ; kept coupé à 6 (M5a-8).
export function validate(raw: unknown, ctx: { title: string; text: string }): { kept: Question[]; rejected: Partial<Record<Rule, number>> } {
  const text = norm(ctx.text)
  // Titre privé de sa parenthèse finale, comme answer_is_title, cherché en mots entiers (« Mozart » n'est pas « Art »). Ses caractères
  // sont des lettres, des chiffres et des espaces : aucun n'a de sens dans une expression rationnelle.
  const title = norm(ctx.title.replace(/\s*\([^()]*\)\s*$/, ''))
  const titleWords = title ? new RegExp(`(?<=^| )${title}(?= |$)`, 'g') : null
  const kept: Question[] = []
  const rejected: Partial<Record<Rule, number>> = {}
  const check = (item: unknown): Rule | null => {
    const parsed = Shape.safeParse(item)
    if (!parsed.success) return 'shape'
    const q = parsed.data
    const o = q.options.map(norm)
    if (len(q.prompt) < 10 || len(q.prompt) > 200 || q.options.some((x) => len(x) < 1 || len(x) > 80) || o.includes('')
      || len(q.evidence) < 20 || len(q.evidence) > 300) return 'lengths'
    if (new Set(o).size < 4) return 'distinct'
    const ev = norm(q.evidence)
    if (!text.includes(ev)) return 'evidence_source'
    const answer = o[q.correct]
    if (!ev.includes(answer)) return 'answer_in_evidence'
    if (o.some((x, i) => i !== q.correct && ev.includes(x))) return 'distractor_in_evidence'
    const prompt = norm(q.prompt)
    // Sous-chaîne, comme le strpos de quiz_check_one.
    if (prompt.includes(answer)) return 'answer_in_prompt'
    // Plus strict que quiz_check_one, qui ne refuse qu'une réponse égale au titre.
    if ((titleWords && answer.match(titleWords)) || fullWords(titleWords ? prompt.replace(titleWords, ' ') : prompt) < 3) return 'title'
    if ([q.prompt, ...q.options].some((x) => LINK.test(x)) || o.some((x) => CATCH_ALL.test(x)) || OFF_TOPIC.test(prompt)) return 'forbidden'
    if (kept.some((k) => norm(k.options[k.correct]) === answer || jaccard(norm(k.prompt), prompt) > 0.7)) return 'duplicate'
    kept.push(q)
    return null
  }
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    const rule = check(item)
    if (rule) rejected[rule] = (rejected[rule] ?? 0) + 1
  }
  return { kept: kept.slice(0, 6), rejected }
}
