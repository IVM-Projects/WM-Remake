import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const at = (date: string) => new Response(null, { headers: { Date: date } })

beforeEach(() => vi.resetModules())
afterEach(() => vi.useRealTimers())

test('serverNow suit l\'en-tête Date, et ignore une réponse sans Date', async () => {
  const { noteServerDate, serverNow } = await import('./clock')
  vi.useFakeTimers({ now: Date.parse('2026-10-20T10:00:00.400Z') })
  expect(serverNow()).toBe(Date.parse('2026-10-20T10:00:00.400Z'))
  noteServerDate(at('Tue, 20 Oct 2026 10:05:00 GMT'))
  expect(serverNow()).toBe(Date.parse('2026-10-20T10:05:00Z'))
  vi.advanceTimersByTime(1500)
  expect(serverNow()).toBe(Date.parse('2026-10-20T10:05:01.500Z'))
  noteServerDate(new Response(null))
  expect(serverNow()).toBe(Date.parse('2026-10-20T10:05:01.500Z'))
})

test('une mesure plus basse de moins d\'une seconde (troncature) ne fait pas reculer l\'horloge ; un saut réel est suivi', async () => {
  const { noteServerDate, serverNow } = await import('./clock')
  vi.useFakeTimers({ now: Date.parse('2026-10-20T10:00:00.000Z') })
  noteServerDate(at('Tue, 20 Oct 2026 10:00:00 GMT'))
  vi.advanceTimersByTime(900)
  // Même seconde tronquée, lue 900 ms plus tard : -900 ms de décalage, ignorés.
  noteServerDate(at('Tue, 20 Oct 2026 10:00:00 GMT'))
  expect(serverNow()).toBe(Date.parse('2026-10-20T10:00:00.900Z'))
  // L'horloge locale avance d'une heure : le serveur, lui, n'a pris que 100 ms.
  vi.setSystemTime(Date.parse('2026-10-20T11:00:01.000Z'))
  noteServerDate(at('Tue, 20 Oct 2026 10:00:01 GMT'))
  expect(serverNow()).toBe(Date.parse('2026-10-20T10:00:01.000Z'))
})
