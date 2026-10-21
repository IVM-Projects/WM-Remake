import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unguardedDml } from './check-dml.ts'

describe('unguardedDml', () => {
  it('signale DELETE et UPDATE sans WHERE', () => {
    expect(unguardedDml('delete from t;')).toEqual(['delete from t'])
    expect(unguardedDml('update wm.x set a = 1;')).toEqual(['update wm.x set a = 1'])
  })

  it('laisse passer les instructions gardées, les upserts et les commentaires', () => {
    expect(unguardedDml('delete from t where true;')).toEqual([])
    expect(unguardedDml('update t set a = 1\n where id = 2;')).toEqual([])
    expect(unguardedDml('insert into t (k, v) values (1, 2) on conflict (k) do update set v = excluded.v;')).toEqual([])
    expect(unguardedDml('-- delete from t;\nselect 1;')).toEqual([])
  })

  it("ne lit que la suite de chaque DML : un WHERE avant lui, ou celui d'un autre DML, ne le garde pas", () => {
    expect(unguardedDml("do $$ begin\n  if exists (select from t where k = 1) then\n    delete from wm.u;\n  end if;\nend $$;")).toEqual(['delete from wm.u'])
    expect(unguardedDml('with a as (update t set x = 1 where id = 1 returning *) delete from u;')).toEqual(['delete from u'])
  })
})

describe('CLI check-dml', () => {
  const cli = new URL('./check-dml.ts', import.meta.url).pathname
  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'check-dml-'))
    try {
      for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
      return spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('fichier fautif : code 1, « fichier : instruction » sur stderr, stdout vide', () => {
    const r = run({ 'a.sql': 'delete from t where true;', 'b.sql': 'select 1;\nupdate wm.x set a = 1;' })
    expect([r.status, r.stdout, r.stderr]).toEqual([1, '', 'b.sql : update wm.x set a = 1\n'])
  })

  it('dossier propre : code 0, rien sur stdout ni stderr', () => {
    const r = run({ 'a.sql': 'delete from t where true;', 'notes.txt': 'delete from t;' })
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', ''])
  })
})
