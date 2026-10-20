import { expect, test } from 'vitest'
import { currentPrefs, setPrefs } from './prefs'

test('setPrefs : currentPrefs reflète aussitôt les préférences enregistrées', () => {
  expect(currentPrefs()).toEqual({ sounds: false, hideSensitive: true, ready: false })
  setPrefs({ sounds: true, hideSensitive: false })
  expect(currentPrefs()).toEqual({ sounds: true, hideSensitive: false, ready: true })
  setPrefs({ sounds: false, hideSensitive: false })
  expect(currentPrefs()).toEqual({ sounds: false, hideSensitive: false, ready: true })
})
