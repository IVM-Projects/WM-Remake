// Réponse de /api/cards/{id}/credits (wm.card_media) : la licence est toujours là (P15), l'auteur peut manquer.
export type Credit = { file: string; image_author: string | null; image_license: string; license_url: string | null }

// Auteur et licence de l'image d'une carte (M2-16).
export function ImageCredit({ credit }: { credit: Credit }) {
  const { image_author, image_license, license_url } = credit
  return (
    <p>
      {`Image : ${image_author ?? 'auteur inconnu'}, `}
      {license_url ? (
        <a href={license_url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline hover:text-accent-light">
          {image_license}
        </a>
      ) : (
        image_license
      )}
    </p>
  )
}
