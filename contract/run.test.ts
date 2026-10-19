import { describe, inject, it } from 'vitest'
import { specs } from './spec/index.ts'

const env = inject('contract')

for (const spec of specs) {
  describe(`${spec.method} ${spec.path} (${spec.source})`, () => {
    for (const c of spec.cases) it(c.name, () => c.run(env))
  })
}
