import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// public/sw.js (M4b-23) chargé dans un contexte où `self` est simulé : gestionnaires enregistrés, notifications montrées, fenêtres ouvertes.
function worker() {
  const on: Record<string, (e: unknown) => void> = {}
  const shown: [string, { body?: string; tag?: string; data?: { url?: string } }][] = []
  const opened: string[] = []
  const waits: Promise<unknown>[] = []
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { on[type] = fn },
    registration: { showNotification: async (title: string, opts: (typeof shown)[number][1]) => void shown.push([title, opts]) },
    location: { origin: 'https://jeu.example' },
    clients: { matchAll: async () => [], openWindow: async (url: string) => void opened.push(url) },
  }
  runInNewContext(readFileSync(new URL('public/sw.js', import.meta.url), 'utf8'), { self, URL })
  const waitUntil = (p: Promise<unknown>) => void waits.push(p)
  return {
    shown,
    opened,
    push: async (text: string | null) => {
      on.push({ data: text === null ? null : { json: () => JSON.parse(text) }, waitUntil })
      await Promise.all(waits)
    },
    click: async (url: unknown) => {
      on.notificationclick({ notification: { close: () => {}, data: { url } }, waitUntil })
      await Promise.all(waits)
    },
  }
}

describe('public/sw.js', () => {
  it('charge de lib/push.ts : son titre, son texte, son tag et son adresse', async () => {
    const w = worker()
    await w.push(JSON.stringify({ title: 'Jeu', body: 'Bob t\'a écrit', url: '/dms?with=x', tag: 'dm:x' }))
    expect(w.shown).toEqual([['Jeu', { body: 'Bob t\'a écrit', tag: 'dm:x', icon: '/icon', data: { url: '/dms?with=x' } }]])
  })

  it.each([['vide', null], ['non JSON', 'x'], ['JSON sans objet', 'null'], ['titre absent', '{"body":"b"}']])(
    'charge %s → le titre neutre par défaut, sans lever', async (_, text) => {
      const w = worker()
      await w.push(text)
      expect(w.shown.map(([title]) => title)).toEqual(['Nouvelle notification'])
    })

  it.each([
    ['même origine', '/friends', 'https://jeu.example/friends'],
    ['autre origine', 'https://ailleurs.example/x', 'https://jeu.example/'],
    ['malformée', 'http://[', 'https://jeu.example/'],
    ['absente', undefined, 'https://jeu.example/'],
  ])('clic, adresse %s (%s) → %s', async (_, url, href) => {
    const w = worker()
    await w.click(url)
    expect(w.opened).toEqual([href])
  })
})
