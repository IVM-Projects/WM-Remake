import type { RouteSpec } from '../../lib/contract.ts'
import { gate } from './gate.ts'
import { health } from './health.ts'

// Une entrée par route ; recap-coverage.ts compte les routes du recap couvertes ici.
export const specs: RouteSpec[] = [health, gate]
