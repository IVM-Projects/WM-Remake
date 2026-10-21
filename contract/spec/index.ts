import type { RouteSpec } from '../../lib/contract.ts'
import { accounts } from './accounts.ts'
import { auth } from './auth.ts'
import { cards } from './catalog.ts'
import { collection } from './collection.ts'
import { credits } from './credits.ts'
import { cron } from './cron.ts'
import { gate } from './gate.ts'
import { health } from './health.ts'
import { marketReads, marketWrites } from './market.ts'
import { packs } from './packs.ts'
import { restSpecs } from './rest.ts'
import { wallet } from './wallet.ts'

// Une entrée par route ; recap-coverage.ts compte les routes du recap couvertes ici.
export const specs: RouteSpec[] = [health, gate, auth, ...packs, wallet, ...collection, cards, credits, cron, ...accounts, ...restSpecs, ...marketWrites, ...marketReads]
