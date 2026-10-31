type Flags = { hide_image: boolean; nsfw_image: boolean }

// Texte de confirmation d'un changement de drapeaux d'image, partagé par /admin/cards et /admin/reports. Prédicat de
// wm.admin_card_flags (2220) : un drapeau qui passe de faux à vrai retire les avatars qui montrent la carte.
export function flagsConsequence(from: Flags, to: Flags): string {
  if ((to.hide_image && !from.hide_image) || (to.nsfw_image && !from.nsfw_image)) {
    return 'Les avatars qui montrent cette image sont retirés ; les signalements de cette carte sont effacés.'
  }
  return `${from.hide_image && !to.hide_image ? 'L\'image redevient visible. ' : ''}Les signalements de cette carte sont effacés : le compteur repart de zéro.`
}
