// Réponse de /api/cards/{id}/credits (wm.card_media) : la licence est toujours là (P15), l'auteur peut manquer.
export type Credit = { file: string; image_author: string | null; image_license: string; license_url: string | null }

const link = 'font-medium text-accent underline hover:text-accent-light'

// Auteur et licence de l'image d'une carte (M2-16) ; l'auteur mène à la page du fichier sur Commons, que CC BY-SA exige
// (M2-R10) et qui nomme l'auteur quand les métadonnées ne le donnent pas. wrap-anywhere : des auteurs réels sont des noms de
// fichiers sans espace, qui débordaient à 320 px (WCAG 1.4.10).
export function ImageCredit({ credit }: { credit: Credit }) {
  const { file, image_author, image_license, license_url } = credit
  return (
    <p className="wrap-anywhere">
      {'Image : '}
      <a href={`https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`} target="_blank" rel="noopener noreferrer" className={link}>
        {image_author || 'voir la page du fichier'}
      </a>
      {', '}
      {license_url ? (
        <a href={license_url} target="_blank" rel="noopener noreferrer" className={link}>
          {image_license}
        </a>
      ) : (
        image_license
      )}
    </p>
  )
}
