import { describe, it, expect } from 'vitest'
import { resolveTz } from '@/lib/tz'

describe('resolveTz', () => {
  it('garde un fuseau IANA valide', () => expect(resolveTz('America/Montreal')).toBe('America/Montreal'))
  it.each(['../../etc/passwd', 'Mars/Phobos', '', null, 'A'.repeat(65), '+05:00'])('%j → Europe/Paris', (h) =>
    expect(resolveTz(h)).toBe('Europe/Paris'))
})
