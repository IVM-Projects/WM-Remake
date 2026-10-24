import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { assertFree } from './harness.ts'

// Socket d'un run précédent (TIME_WAIT d'un client psql, jusqu'à 60 s) : assertFree attend que le port se libère au lieu d'échouer.
it('assertFree attend un port occupé qui se libère', async () => {
  const held = createServer().listen(0, '127.0.0.1')
  await once(held, 'listening')
  const { port } = held.address() as AddressInfo
  setTimeout(() => held.close(), 300)
  await expect(assertFree(port)).resolves.toBeUndefined()
})
