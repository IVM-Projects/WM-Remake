import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { BellButton } from './Bell'

const html = (unread: number) => renderToStaticMarkup(<BellButton unread={unread} onClick={() => {}} describedBy="bell-count" />)

test('bouton du contrat (R§6.8) : nom figé, compte relié par aria-describedby', () => {
  const button = html(3).match(/<button [^>]*>/)?.[0] ?? ''
  expect(button).toContain('aria-label="Notifications"')
  expect(button).toMatch(/class="relative p-2 rounded-xl /)
  expect(button).toContain('aria-describedby="bell-count"')
})

// Badge : le span masqué aux lecteurs d'écran, frère du bouton.
const badge = (unread: number) => html(unread).match(/<span aria-hidden="true"[^>]*>([^<]*)<\/span>/)?.[1]

test('badge : absent à 0, nombre exact sous 10, « 9+ » dès 10', () => {
  expect(badge(0)).toBeUndefined()
  expect(badge(3)).toBe('3')
  expect(badge(9)).toBe('9')
  expect(badge(10)).toBe('9+')
})
