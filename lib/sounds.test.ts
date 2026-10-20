import { beforeEach, expect, test, vi } from 'vitest'

let sounds = true
vi.mock('./prefs', () => ({ currentPrefs: () => ({ sounds, hideSensitive: true, ready: true }) }))

const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} })
// Juste ce que lib/sounds.ts appelle ; compte les contextes et les oscillateurs.
class FakeAudio {
  static made = 0
  static oscillators = 0
  state = 'running'
  currentTime = 0
  sampleRate = 8000
  destination = {}
  constructor() { FakeAudio.made++ }
  node = () => ({ connect: <T,>(n: T) => n, start() {}, stop() {}, gain: param(), frequency: param(), Q: param() })
  createGain = this.node
  createBufferSource = this.node
  createBiquadFilter = this.node
  createOscillator = () => (FakeAudio.oscillators++, this.node())
  createBuffer = (_: number, length: number) => ({ length, copyToChannel() {} })
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeAudio.made = FakeAudio.oscillators = 0
  sounds = true
})

test('sans AudioContext (Node, vieux navigateur), rien n\'échoue', async () => {
  const { playFlip, playLegendary, playRip } = await import('./sounds')
  expect(() => { playRip(); playFlip(); playLegendary() }).not.toThrow()
})

test('sons coupés : aucun contexte audio créé', async () => {
  vi.stubGlobal('AudioContext', FakeAudio)
  sounds = false
  const { playFlip, playLegendary, playRip } = await import('./sounds')
  playRip(); playFlip(); playLegendary()
  expect(FakeAudio.made).toBe(0)
})

test('sons actifs : un seul contexte, partagé, et des notes jouées', async () => {
  vi.stubGlobal('AudioContext', FakeAudio)
  const { playFlip, playLegendary, playRip } = await import('./sounds')
  playRip(); playFlip(); playLegendary()
  expect(FakeAudio.made).toBe(1)
  expect(FakeAudio.oscillators).toBe(6)
})

test('un constructeur qui lève (trop de contextes) reste silencieux', async () => {
  vi.stubGlobal('AudioContext', class { constructor() { throw new Error('NotSupportedError') } })
  const { playRip } = await import('./sounds')
  expect(() => playRip()).not.toThrow()
})
