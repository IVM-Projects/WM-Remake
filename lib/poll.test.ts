import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createPoller } from './poll'

// Sans DOM (R18) : document simulé par un EventTarget à visibilityState modifiable.
function fakeDoc() {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
  const show = (v: DocumentVisibilityState) => {
    doc.visibilityState = v
    doc.dispatchEvent(new Event('visibilitychange'))
  }
  return { doc, show }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('run à 15 s, puis à 30 s', async () => {
  const run = vi.fn()
  const { doc } = fakeDoc()
  createPoller({ run, delay: () => 15_000, doc })
  await vi.advanceTimersByTimeAsync(14_999)
  expect(run).toHaveBeenCalledTimes(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(run).toHaveBeenCalledTimes(2)
})

test('caché : aucun appel pendant 60 s ; visible + visibilitychange : un appel immédiat', async () => {
  const run = vi.fn()
  const { doc, show } = fakeDoc()
  createPoller({ run, delay: () => 15_000, doc })
  show('hidden')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(run).toHaveBeenCalledTimes(0)
  show('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(1)
  // Puis le rythme normal reprend après ce passage.
  await vi.advanceTimersByTimeAsync(15_000)
  expect(run).toHaveBeenCalledTimes(2)
})

test('un run de 20 s ne se chevauche jamais avec le suivant', async () => {
  let active = 0
  let max = 0
  const run = vi.fn(async () => {
    max = Math.max(max, ++active)
    await new Promise((r) => setTimeout(r, 20_000))
    active--
  })
  const { doc, show } = fakeDoc()
  createPoller({ run, delay: () => 15_000, doc })
  await vi.advanceTimersByTimeAsync(15_000)
  expect(run).toHaveBeenCalledTimes(1)
  // Retour en visible pendant le passage : pas de second passage en parallèle.
  show('hidden')
  show('visible')
  await vi.advanceTimersByTimeAsync(19_999)
  expect(run).toHaveBeenCalledTimes(1)
  // Fin à 35 s : le suivant part 15 s après, à 50 s.
  await vi.advanceTimersByTimeAsync(1 + 14_999)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(2)
  expect(max).toBe(1)
})

test('delay relu à chaque tour (2 000, puis 10 000) ; après stop(), plus aucun appel ni écouteur', async () => {
  const run = vi.fn()
  const delay = vi.fn().mockReturnValueOnce(2_000).mockReturnValue(10_000)
  const { doc, show } = fakeDoc()
  const add = vi.spyOn(doc, 'addEventListener')
  const remove = vi.spyOn(doc, 'removeEventListener')
  const stop = createPoller({ run, delay, doc })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(9_999)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(2)
  stop()
  expect(remove).toHaveBeenCalledWith('visibilitychange', add.mock.calls[0][1])
  show('hidden')
  show('visible')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(run).toHaveBeenCalledTimes(2)
})

test('deux visible de suite pendant l\'attente : une seule chaîne (le minuteur en cours est annulé)', async () => {
  const run = vi.fn()
  const { doc, show } = fakeDoc()
  createPoller({ run, delay: () => 15_000, doc })
  await vi.advanceTimersByTimeAsync(1_000)
  show('visible')
  show('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(1)
  // Le minuteur d'origine (15 s) ne part plus : prochain passage à 16 s, puis à 31 s.
  await vi.advanceTimersByTimeAsync(14_999)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(run).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(1)
})

test('un run qui échoue n\'arrête pas le polling', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('réseau')).mockResolvedValue(undefined)
  const { doc } = fakeDoc()
  createPoller({ run, delay: () => 1_000, doc })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(run).toHaveBeenCalledTimes(2)
})
