import type { BrowserContext, Locator, Page } from '@playwright/test'
import { forbiddenKeys, idCounts } from '../contract/leak.ts'
import { formatInt } from '../lib/format.ts'
import { befriend, cookieFor, expect, giveCopies, hydrated, makePlayer, sql, test } from './fixtures'

type User = ReturnType<typeof makePlayer>
// Une réponse d'une adresse de bataille, gardée pour la mesure de fuite (C23) : la requête qui l'a demandée et le texte du corps.
type Kept = { method: string; action: string | null; questionId: string | null; body: string }
type Question = { id: string; options: { id: string }[] }

// Sélecteurs repris de battle.spec.ts et social-journey.spec.ts. Une page quittée reste dans le DOM, masquée (Activity) : seul le visible compte.
const ready = (page: Page) => page.locator('main [data-ready]').filter({ visible: true }).waitFor()
const line = (page: Page, text: string) => page.locator('main').getByText(text, { exact: true }).filter({ visible: true })
const bell = (page: Page) => page.locator('button[aria-label="Notifications"]')
const panel = (page: Page, u: User) => page.getByRole('region', { name: u.username, exact: true })
const slots = (page: Page) => page.getByRole('region', { name: 'Choisis tes 3 cartes' }).getByRole('listitem')
const question = (page: Page, k: number) => page.getByRole('heading', { level: 3, name: `Question ${k} / 3`, exact: true })
const verdict = (page: Page) => page.locator('main').getByRole('status').filter({ hasText: /^(Bonne réponse !|Mauvaise réponse\.)/ })
const journal = (page: Page) => page.getByRole('log', { name: 'Déroulé de la bataille' }).getByRole('listitem')
const end = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true })
const isBattle = (url: string) => new URL(url).pathname.startsWith('/api/battles')
// Le poll de l'arène passe toutes les 3 s : l'autre joueur voit son nouvel état en moins de 10 s.
const POLL = { timeout: 10_000 }
const ATTACK = 'À toi d\'attaquer : choisis une carte.'

// Clavier seul : focus, puis Entrée.
async function press(target: Locator) {
  await target.focus()
  await target.press('Enter')
}
// Emplacement n : « Ajouter une carte à l'emplacement n », puis Entrée sur la carte du sélecteur.
async function place(page: Page, n: number, title: string) {
  await press(slots(page).nth(n - 1).getByRole('button', { name: `Ajouter une carte à l'emplacement ${n}` }))
  const dialog = page.getByRole('dialog', { name: 'Choisir une carte pour ton deck' })
  await press(dialog.getByRole('button', { name: title, exact: true }))
  await expect(dialog).toHaveCount(0)
}

// Critère du jalon (M5a) : A défie B depuis le lobby, B accepte depuis la cloche, chacun pose son deck, six tours de quiz à l'issue fixée
// (B juste partout, A faux partout), B gagne au ratio et chacun reçoit sa récompense. Banques de modèles `views` seulement, aucun LLM. Un
// contexte de navigateur par joueur ; seules écritures SQL : l'étape 1 ; les secrets, lus en SQL, choisissent les réponses et mesurent la fuite.
test('parcours M5a au clavier : défi → cloche → acceptation → decks → six tours de quiz → victoire de B et récompenses, sans aucun LLM ni bonne réponse dans aucune réponse', async ({ browser, baseURL }) => {
  // 0.
  test.setTimeout(240_000)
  const contexts: BrowserContext[] = []
  const uids: string[] = []
  try {
    // 1. Cartes du seed (supabase/seed.sql:8-9) : R n° 0121 à 0123 pour A (ATK 5 477, 4 014, 4 051 ; PV 13 398), PC n° 0401 à 0403 pour B
    // (ATK 3 837, 3 874, 3 911 ; PV 8 418).
    const a = makePlayer()
    uids.push(a.uid)
    const b = makePlayer()
    uids.push(b.uid)
    befriend(a, b)
    const deckOf = (copies: string[]) => copies.map((id) => {
      const [title, atk] = sql(`select snapshot_title || '|' || snapshot_atk from public.user_cards where id = :'id'`, { id }).split('|')
      return { title, atk: Number(atk) }
    })
    const [da, db] = [deckOf(giveCopies(a, 'R', 3)), deckOf(giveCopies(b, 'PC', 3))]
    for (const u of [a, b]) {
      const ctx = await browser.newContext()
      contexts.push(ctx)
      await ctx.addCookies([{ ...cookieFor(u), url: baseURL! }])
    }
    const [ap, bp] = await Promise.all(contexts.map((c) => c.newPage()))

    // 2. Chaque réponse d'une adresse de bataille ; une réponse lue pendant la fermeture des contextes rend null, sans rejet hors du test.
    const bodies: Promise<Kept | null>[] = []
    for (const page of [ap, bp]) {
      page.on('response', (r) => {
        if (isBattle(r.url())) bodies.push(r.body().then((b) => ({ method: r.request().method(), action: r.request().postDataJSON()?.action ?? null, questionId: r.request().postDataJSON()?.questionId ?? null, body: b.toString() }), () => null))
      })
    }

    // 3. A défie B depuis le lobby.
    await ap.goto('/battle')
    await ready(ap)
    await press(ap.getByRole('region', { name: 'Défier un ami' }).getByRole('listitem').filter({ hasText: b.username }).getByRole('button', { name: 'Défier' }))
    await expect(ap).toHaveURL(/\/battle\/[0-9a-f-]{36}$/)
    const id = new URL(ap.url()).pathname.split('/').pop()!
    await expect(line(ap, `En attente de la réponse de ${b.username}.`)).toBeVisible()

    // 4. B : la cloche mène à l'arène, B accepte.
    await bp.goto('/pulls')
    await hydrated(bell(bp))
    await press(bell(bp))
    await press(bp.getByRole('dialog', { name: 'Notifications' }).getByRole('link', { name: `${a.username} te défie en bataille`, exact: true }))
    await expect(bp).toHaveURL(`/battle/${id}`)
    await ready(bp)
    await press(bp.getByRole('button', { name: 'Accepter' }))

    // 5. B pose son deck, puis A, le dernier : la bataille commence, A attaque au tour 1.
    for (const [n, c] of db.entries()) await place(bp, n + 1, c.title)
    await press(bp.getByRole('button', { name: 'Valider mon deck' }))
    await expect(line(bp, `Deck validé. En attente du deck de ${a.username}.`)).toBeVisible()
    await expect(ap.getByRole('button', { name: 'Ajouter une carte à l\'emplacement 1' })).toBeVisible(POLL)
    for (const [n, c] of da.entries()) await place(ap, n + 1, c.title)
    await press(ap.getByRole('button', { name: 'Valider mon deck' }))
    await expect(line(ap, ATTACK)).toBeVisible()
    await expect(line(bp, `${a.username} choisit sa carte d'attaque.`)).toBeVisible(POLL)

    // 6. Six tours : A attaque aux tours impairs, B aux pairs ; le défenseur B répond juste, A faux. Une question se désigne par son rang
    // (un énoncé views revient d'une question à l'autre) ; la k-ième ligne de la lecture est la bonne option du h3 « Question k / 3 ».
    const seen: string[] = []
    for (let n = 1; n <= 6; n++) {
      const [att, def, attPage, defPage, deck] = n % 2 ? [a, b, ap, bp, da] : [b, a, bp, ap, db]
      const card = deck[Math.floor((n - 1) / 2)]
      await expect(line(attPage, ATTACK)).toBeVisible(POLL)
      await press(panel(attPage, att).getByRole('button', { name: 'Attaquer' }).first())
      await expect(line(attPage, `${def.username} répond aux questions : 0 / 3`)).toBeVisible()
      const rights = sql(`select o ->> 'text' from public.battles b cross join jsonb_array_elements(b.game_state -> 'pendingAttack' -> 'questions') with ordinality q (v, k) join wm.battle_secrets s on s.battle_id = b.id and s.question_id = (q.v ->> 'id')::uuid cross join jsonb_array_elements(q.v -> 'options') o where b.id = :'id' and o ->> 'id' = s.correct_option_id order by q.k`, { id }).split('\n')
      expect(rights).toHaveLength(3)
      for (const [i, right] of rights.entries()) {
        await expect(question(defPage, i + 1)).toBeVisible(POLL)
        const texts = await defPage.locator('main fieldset label').allTextContents()
        const pick = def === b ? right : texts.find((t) => t !== right)!
        const radio = defPage.locator('main').getByRole('radio', { name: pick, exact: true })
        await radio.focus()
        await defPage.keyboard.press('Space')
        await expect(radio).toBeChecked()
        await press(defPage.getByRole('button', { name: 'Valider ma réponse' }))
        await expect(verdict(defPage)).toHaveText(def === b ? 'Bonne réponse !' : `Mauvaise réponse. La bonne réponse était : ${right}`)
        await press(defPage.getByRole('button', { name: 'Continuer' }))
      }
      seen.push(`Tour ${n} : ${att.username} attaque avec ${card.title}. ${def === b ? 'Aucune erreur : aucun dégât.' : `3 mauvaises réponses sur 3 : ${formatInt(card.atk)} dégâts.`}`)
      await expect(journal(defPage)).toHaveText(seen)
    }

    // 7. Fin : B gagne au ratio (C8 : 1 776 × 8 418 contre 8 418 × 13 398), A n'a rien infligé, B 11 622 dégâts.
    await expect(end(ap, 'Défaite')).toBeFocused()
    await expect(line(ap, '+10 wikibidous')).toBeVisible()
    await expect(end(bp, 'Victoire !')).toBeVisible(POLL)
    await expect(line(bp, '+50 wikibidous')).toBeVisible()
    expect(sql(`select (game_state #>> array['players', :'a', 'currentHp']) || ' ' || (game_state #>> array['players', :'b', 'currentHp'])
  || ' ' || winner_id from public.battles where id = :'id'`, { a: a.uid, b: b.uid, id })).toBe(`1776 8418 ${b.uid}`)
    expect(sql(`select string_agg(reason || ' ' || user_id || ' ' || delta, ',' order by delta desc) from wm.wb_ledger where ref = 'battle:' || :'id'`,
      { id })).toBe(`battle ${b.uid} 50,battle ${a.uid} 10`)
    expect(sql(`select battles_won from wm.user_stats where user_id = :'b'`, { b: b.uid })).toBe('1')
    expect(sql(`select string_agg(q.source, ',') from public.battle_decks d cross join unnest(d.card_ids) c join wm.card_quizzes q on q.card_id = c
where d.battle_id = :'id'`, { id })).toBe(Array(6).fill('template').join(','))
    // Filtré sur la partie : les autres fichiers tournent en parallèle (a11y.spec.ts crée une violation ledger_balance passagère).
    expect(sql(`select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(wm.check_invariants()) v where v ->> 'user_id' in (:'a', :'b') or v ->> 'battle_id' = :'id' or v ->> 'ref' = 'battle:' || :'id'`,
      { a: a.uid, b: b.uid, id })).toBe('[]')

    // 8. Fuite, côté navigateur (C23) : aucune réponse reçue ne distingue la bonne option des trois autres, hors du correct_answer_id d'une
    // réponse à sa propre question ; aucune clé interdite à aucune profondeur.
    const kept = (await Promise.all(bodies)).filter((x) => x !== null)
    expect(kept.filter((x) => x.action === 'submit_single_answer'), 'réponses aux 18 questions gardées').toHaveLength(18)
    const secrets = sql(`select question_id || ' ' || correct_option_id from wm.battle_secrets where battle_id = :'id'`, { id }).split('\n').map((l) => l.split(' '))
    expect(secrets).toHaveLength(18)
    const options = new Map<string, string[]>()
    for (const x of kept) {
      const qs = (JSON.parse(x.body) as { battle?: { game_state?: { pendingAttack?: { questions: Question[] } | null } | null } }).battle?.game_state?.pendingAttack?.questions ?? []
      for (const q of qs) options.set(q.id, q.options.map((o) => o.id))
    }
    for (const [q, s] of secrets) {
      const ids = options.get(q)
      expect(ids, `question ${q} jamais vue`).toHaveLength(4)
      expect(ids).toContain(s)
      const others = ids!.filter((o) => o !== s)
      for (const x of kept) {
        const [m] = idCounts(x.body, others)
        const extra = x.action === 'submit_single_answer' && x.questionId === q ? 1 : 0
        expect(idCounts(x.body, [s, ...others]), `${x.method} ${x.action ?? ''} : ${x.body.slice(0, 300)}`).toEqual([m + extra, m, m, m])
      }
    }
    for (const x of kept) expect(forbiddenKeys(JSON.parse(x.body), x.action === 'submit_single_answer'), `${x.method} ${x.action ?? ''}`).toEqual([])

    // 9. A : la bataille sous « Terminées », en « Défaite ».
    await ap.goto('/battle')
    await ready(ap)
    await press(ap.getByRole('tab', { name: 'Terminées' }))
    const done = ap.getByRole('tabpanel').getByRole('link')
    await expect(done).toHaveCount(1)
    await expect(done).toContainText(`Contre ${b.username}`)
    await expect(done.getByText('Défaite', { exact: true })).toBeVisible()
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
    // Bataille, decks, secrets, amitié, copies, grand livre et notifications suivent en cascade.
    sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: uids.join(',') })
  }
})
