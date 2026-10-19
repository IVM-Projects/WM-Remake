import type { MetadataRoute } from 'next'
import { connection } from 'next/server'
import { gateEnv } from '@/lib/gate'

export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection() // évalué à la requête : la porte dépend des variables d'exécution, pas du build
  return gateEnv()
    ? { rules: { userAgent: '*', disallow: '/' } }
    : { rules: { userAgent: '*', allow: '/', disallow: '/api/' } }
}
