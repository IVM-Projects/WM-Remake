// `node contract/serve.ts` : backend + serveurs Next 3100 (sans porte) et 3101 (porte), au premier plan (Playwright webServer).
import { startStack } from './harness.ts'

const stack = await startStack()
console.log(`Banc prêt : ${stack.plain} (sans porte) · ${stack.gated} (porte) · ${stack.backend.supabaseUrl} (passerelle)`)
// Un seul arrêt même si plusieurs signaux arrivent (Ctrl-C répété, SIGTERM puis SIGINT).
let stopping: Promise<void> | undefined
const shutdown = () => void (stopping ??= stack.stop().finally(() => process.exit(0)))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
