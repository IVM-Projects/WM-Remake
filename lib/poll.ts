import { useEffect, useEffectEvent } from 'react'

type Doc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>

// Polling visible seulement (C15, D§9.5) : un passage à la fois, le suivant delay() ms après la fin du précédent ; rien onglet caché,
// un passage immédiat au retour en visible. Logique pure : vitest tourne sans DOM (R18), document et minuteurs se simulent.
export function createPoller(o: {
  run: () => Promise<void> | void
  delay: () => number
  doc?: Doc
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}): () => void {
  const { run, delay, doc = document, setTimer = setTimeout, clearTimer = clearTimeout } = o
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let stopped = false
  const schedule = () => {
    clearTimer(timer)
    timer = !stopped && doc.visibilityState === 'visible' ? setTimer(tick, delay()) : undefined
  }
  async function tick() {
    // Un retour en visible pendant l'attente lance tick directement : le minuteur en cours est annulé, une seule chaîne survit.
    clearTimer(timer)
    timer = undefined
    if (running || stopped || doc.visibilityState !== 'visible') return
    running = true
    // run gère ses erreurs ; une erreur qui lui échappe n'arrête pas le polling.
    try { await run() } catch {} finally {
      running = false
      schedule()
    }
  }
  // Retour en visible pendant un passage : tick ne fait rien, la fin du passage reprogramme.
  const onVisibility = () => (doc.visibilityState === 'visible' ? void tick() : schedule())
  doc.addEventListener('visibilitychange', onVisibility)
  schedule()
  return () => {
    stopped = true
    clearTimer(timer)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}

// createPoller dans un effet : arrêté au démontage, au masquage par Activity (preserving-ui-state.md, « Effect and media cleanup ») et quand
// enabled devient faux. run et delay lus par useEffectEvent : toujours l'état du dernier rendu.
export function usePoll(run: () => Promise<void> | void, delay: number | (() => number), enabled = true): void {
  const onRun = useEffectEvent(run)
  const onDelay = useEffectEvent(() => (typeof delay === 'function' ? delay() : delay))
  useEffect(() => (enabled ? createPoller({ run: () => onRun(), delay: () => onDelay() }) : undefined), [enabled])
}
