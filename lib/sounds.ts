import { currentPrefs } from './prefs'

// Nos sons, synthétisés en WebAudio (D§8.5) : aucun fichier audio de l'original.
let ctx: AudioContext | null = null

// Contexte créé au premier son, donc après un geste du joueur (avant, l'autoplay le laisserait suspendu).
function audio(): AudioContext | null {
  if (!currentPrefs().sounds || typeof AudioContext === 'undefined') return null
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}

// Attaque de 10 ms puis décroissance exponentielle (une rampe exponentielle ne part ni n'arrive à 0).
function envelope(a: AudioContext, at: number, peak: number, dur: number): GainNode {
  const g = a.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(peak, at + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  g.connect(a.destination)
  return g
}

function tone(a: AudioContext, freq: number, at: number, dur: number, peak: number, type: OscillatorType = 'triangle') {
  const o = a.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(freq, at)
  o.connect(envelope(a, at, peak, dur))
  o.start(at)
  o.stop(at + dur)
}

// Souffle filtré dont la bande glisse de `from` à `to` Hz : le papier qui se déchire, la carte qui fend l'air.
function noise(a: AudioContext, at: number, dur: number, peak: number, from: number, to: number) {
  const buffer = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate)
  buffer.copyToChannel(Float32Array.from({ length: buffer.length }, () => Math.random() * 2 - 1), 0)
  const src = a.createBufferSource()
  src.buffer = buffer
  const band = a.createBiquadFilter()
  band.type = 'bandpass'
  band.Q.value = 0.9
  band.frequency.setValueAtTime(from, at)
  band.frequency.exponentialRampToValueAtTime(to, at + dur)
  src.connect(band).connect(envelope(a, at, peak, dur))
  src.start(at)
  src.stop(at + dur)
}

// Un son raté (pas d'AudioContext, trop de contextes, nœud refusé) ne remonte jamais jusqu'à l'ouverture du paquet.
const sound = (draw: (a: AudioContext, t: number) => void) => (): void => {
  try {
    const a = audio()
    if (a) draw(a, a.currentTime)
  } catch {
    // silence
  }
}

export const playRip = sound((a, t) => {
  noise(a, t, 0.34, 0.45, 700, 4200)
  noise(a, t + 0.06, 0.2, 0.2, 3000, 8000)
})

export const playFlip = sound((a, t) => {
  noise(a, t, 0.1, 0.3, 1600, 5000)
  tone(a, 660, t + 0.03, 0.14, 0.06)
})

// Arpège do-mi-sol-do puis une note haute qui scintille.
export const playLegendary = sound((a, t) => {
  ;[523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(a, f, t + i * 0.11, 1.2 - i * 0.12, 0.11))
  tone(a, 2093, t + 0.48, 1.4, 0.035, 'sine')
})
