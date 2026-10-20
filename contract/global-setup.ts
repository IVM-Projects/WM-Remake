import type { TestProject } from 'vitest/node'
import type { ContractEnv } from '../lib/contract.ts'
import { startStack } from './harness.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    contract: ContractEnv
  }
}

export default async function setup({ provide }: TestProject) {
  const { backend, plain, gated, stop } = await startStack()
  const { supabaseUrl, databaseUrl, mailpitUrl, privateJwk } = backend
  provide('contract', { plain, gated, backend: { supabaseUrl, databaseUrl, mailpitUrl, privateJwk } })
  return stop
}
