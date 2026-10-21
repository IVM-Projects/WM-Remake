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

  it("ne lit que la suite de l'instruction : un WHERE avant le DELETE ne le garde pas", () => {
    expect(unguardedDml("do $$ begin\n  if exists (select from t where k = 1) then\n    delete from wm.u;\n  end if;\nend $$;")).toEqual(['delete from wm.u'])
  })
})
