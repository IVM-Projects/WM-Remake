'use client'

import { useId, useState, type FormEvent } from 'react'
import { primary } from '@/components/ui/button'
import type { PendingAttack } from './types'

type Question = PendingAttack['questions'][number]
// Retour d'une réponse : l'option choisie (null : démentie par la réponse enregistrée), le verdict du serveur et le texte de la bonne
// option, lu dans les options de la question affichée.
export type Verdict = { choice: string | null; correct: boolean; right: string }

const inline = 'font-medium text-[var(--color-accent-light)] underline underline-offset-2'

// Une question à la fois, sans minuteur (D:531, M5a-10) : h3 « Question k / n », radios natives de même name (un arrêt de tabulation, les
// flèches pour choisir). Avec `verdict`, la question reste affichée, figée sur le choix envoyé, avec le retour et « Continuer ». h3 et retour
// sont des cibles du focus de l'arène (data-line, data-first, data-verdict).
export function QuizForm({ question, k, n, busy, verdict, source, onAnswer, onContinue }: {
  question: Question
  k: number
  n: number
  busy: boolean
  verdict: Verdict | null
  source: { title: string; url: string } | null
  onAnswer: (answerId: string) => void
  onContinue: () => void
}) {
  const name = useId()
  const [choice, setChoice] = useState<string | null>(null)
  const picked = verdict ? verdict.choice : choice
  const off = busy || !picked

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!verdict && !busy && picked) onAnswer(picked)
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-4">
        <h3 tabIndex={-1} data-line="" data-first="" className="text-lg font-bold outline-none">{`Question ${k} / ${n}`}</h3>
        <fieldset className="space-y-1">
          <legend className="mb-2 font-medium wrap-anywhere">{question.prompt}</legend>
          {question.options.map((o) => (
            <label key={o.id} className="flex min-h-11 items-center gap-3 text-sm wrap-anywhere">
              <input
                type="radio"
                name={name}
                value={o.id}
                checked={picked === o.id}
                aria-disabled={verdict ? true : undefined}
                // Garde : une radio n'a pas de readOnly ; rien ne change pendant l'envoi ni après la réponse.
                onChange={() => { if (!verdict && !busy) setChoice(o.id) }}
                className="size-5 shrink-0 accent-[var(--color-accent)]"
              />
              {o.text}
            </label>
          ))}
        </fieldset>
        {verdict ? (
          <>
            <p role="status" tabIndex={-1} data-verdict="" className={`font-semibold outline-none wrap-anywhere ${verdict.correct ? 'text-green-400' : 'text-red-400'}`}>
              {verdict.correct ? 'Bonne réponse !' : `Mauvaise réponse. La bonne réponse était : ${verdict.right}`}
            </p>
            <button type="button" onClick={onContinue} className={primary}>Continuer</button>
          </>
        ) : (
          <button type="submit" aria-disabled={off || undefined} className={primary}>Valider ma réponse</button>
        )}
      </form>
      {/* Attribution du texte de l'article (C21, D:101, R:553). */}
      {source && <p className="text-xs text-[var(--color-foreground)]/70 wrap-anywhere">
        {'Questions tirées de l\'article Wikipédia « '}
        <a href={source.url} target="_blank" rel="noopener noreferrer" className={inline}>{source.title}</a>
        {' », texte sous licence '}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.fr" target="_blank" rel="noopener noreferrer" className={inline}>CC BY-SA 4.0</a>
        .
      </p>}
    </div>
  )
}
