import assert from 'node:assert/strict'
import type { RouteSpec } from '../../lib/contract.ts'
import { api, failed, psql } from '../users.ts'

const CDN = 'public, max-age=86400, s-maxage=2592000'
const MEDIA = { file: 'Test.jpg', image_author: 'Jean Dupont', image_license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0' }

// Licence de l'image d'une carte (M2-16) : publique, sans session, cachée au CDN.
export const credits: RouteSpec = {
  method: 'GET',
  path: '/api/cards/{id}/credits',
  source: 'D§7.4',
  confidence: 'ajouté',
  cases: [
    {
      name: 'carte avec média → 200 { file, image_author, image_license, license_url } et Cache-Control du CDN, sans session',
      run: async (env) => {
        const id = psql(env.backend.databaseUrl, `insert into wm.card_media (card_id, file, author, license, license_url)
select id, :'file', :'author', :'license', :'url' from public.cards order by wikipedia_title limit 1
on conflict (card_id) do update set file = excluded.file, author = excluded.author, license = excluded.license, license_url = excluded.license_url
returning card_id`, { file: MEDIA.file, author: MEDIA.image_author, license: MEDIA.image_license, url: MEDIA.license_url })
        const res = await api(env, `/api/cards/${id}/credits`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('cache-control'), CDN)
        assert.deepEqual(await res.json(), MEDIA)
      },
    },
    {
      name: 'carte sans média → 404 « Carte introuvable », sans le Cache-Control du CDN',
      run: async (env) => {
        const id = psql(env.backend.databaseUrl, `select id from public.cards c
where not exists (select from wm.card_media m where m.card_id = c.id) order by wikipedia_title limit 1`)
        const res = await api(env, `/api/cards/${id}/credits`)
        assert.notEqual(res.headers.get('cache-control'), CDN)
        assert.equal((await failed(res, 404)).error, 'Carte introuvable')
      },
    },
    {
      name: 'id=abc → 400 invalid_request',
      run: async (env) => void (await failed(await api(env, '/api/cards/abc/credits'), 400, 'invalid_request')),
    },
  ],
}
