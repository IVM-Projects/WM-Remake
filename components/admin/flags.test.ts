import { describe, expect, it } from 'vitest'
import { flagsConsequence } from './flags'

const AVATARS = 'Les avatars qui montrent cette image sont retirés ; les signalements de cette carte sont effacés.'
const RESET = 'Les signalements de cette carte sont effacés : le compteur repart de zéro.'
const f = (hide_image: boolean, nsfw_image: boolean) => ({ hide_image, nsfw_image })

describe('flagsConsequence (prédicat de wm.admin_card_flags)', () => {
  it('un drapeau qui passe de faux à vrai → avatars retirés ; déjà posé ou retiré → compteur seulement', () => {
    expect(flagsConsequence(f(false, false), f(true, false))).toBe(AVATARS)
    expect(flagsConsequence(f(true, false), f(true, true))).toBe(AVATARS)
    expect(flagsConsequence(f(true, false), f(true, false))).toBe(RESET) // masquée d'office, « Masquer » à nouveau
    expect(flagsConsequence(f(false, true), f(false, true))).toBe(RESET)
    expect(flagsConsequence(f(true, true), f(false, true))).toBe(`L'image redevient visible. ${RESET}`)
  })
})
