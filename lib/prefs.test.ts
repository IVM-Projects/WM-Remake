import { beforeEach, expect, test, vi } from 'vitest'

// Lecture paresseuse de /api/settings/preferences, tenue en suspens jusqu'à read.resolve().
const read = vi.hoisted(() => ({ resolve: (() => {}) as (body: unknown) => void }))
vi.mock('./api', () => ({ api: vi.fn(() => new Promise((r) => { read.resolve = r })) }))

// Module neuf par test : l'état du cache est global au module.
beforeEach(() => { vi.resetModules() })
const flush = () => new Promise((r) => setTimeout(r))

test('setPrefs : currentPrefs reflète aussitôt les préférences enregistrées et chaque abonné est prévenu', async () => {
  const { currentPrefs, setPrefs, subscribePrefs } = await import('./prefs')
  expect(currentPrefs()).toEqual({ sounds: false, hideSensitive: true, ready: false })
  const listener = vi.fn()
  subscribePrefs(listener)
  setPrefs({ sounds: true, hideSensitive: false })
  expect(currentPrefs()).toEqual({ sounds: true, hideSensitive: false, ready: true })
  expect(listener).toHaveBeenCalledTimes(1)
  setPrefs({ sounds: false, hideSensitive: false })
  expect(currentPrefs()).toEqual({ sounds: false, hideSensitive: false, ready: true })
  expect(listener).toHaveBeenCalledTimes(2)
})

test('une lecture partie avant setPrefs n\'écrase pas, en revenant, la valeur enregistrée', async () => {
  const { currentPrefs, setPrefs, subscribePrefs } = await import('./prefs')
  const listener = vi.fn()
  subscribePrefs(listener) // lance la lecture
  setPrefs({ sounds: true, hideSensitive: false })
  read.resolve({ sounds: false, hide_sensitive: true })
  await flush()
  expect(currentPrefs()).toEqual({ sounds: true, hideSensitive: false, ready: true })
  expect(listener).toHaveBeenCalledTimes(1)
})

test('témoin : sans enregistrement entre-temps, la lecture s\'applique et prévient les abonnés', async () => {
  const { currentPrefs, subscribePrefs } = await import('./prefs')
  const listener = vi.fn()
  subscribePrefs(listener)
  read.resolve({ sounds: true, hide_sensitive: false })
  await flush()
  expect(currentPrefs()).toEqual({ sounds: true, hideSensitive: false, ready: true })
  expect(listener).toHaveBeenCalledTimes(1)
})
