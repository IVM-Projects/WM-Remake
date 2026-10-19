import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Bell } from './Bell'

test('badge de la cloche : absent à 0, nombre exact jusqu\'à 9, puis « 9+ »', () => {
  expect(renderToStaticMarkup(<Bell />)).not.toContain('<span')
  expect(renderToStaticMarkup(<Bell unread={9} />)).toContain('>9</span>')
  expect(renderToStaticMarkup(<Bell unread={10} />)).toContain('>9+</span>')
})
