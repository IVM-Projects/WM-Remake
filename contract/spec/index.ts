import type { RouteSpec } from '../../lib/contract.ts'
import { auth } from './auth.ts'
import { gate } from './gate.ts'
import { health } from './health.ts'
import { packs } from './packs.ts'
import { wallet } from './wallet.ts'

// Une entrée par route ; recap-coverage.ts compte les routes du recap couvertes ici.
export const specs: RouteSpec[] = [health, gate, auth, ...packs, wallet]
