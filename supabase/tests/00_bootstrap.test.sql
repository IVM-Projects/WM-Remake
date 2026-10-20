do $$ begin
  assert (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')) = 4;
  -- Schéma auth migré par le vrai GoTrue (db-test.sh), plus de stub.
  assert to_regclass('auth.schema_migrations') is not null;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  assert auth.uid() = '00000000-0000-0000-0000-000000000001'::uuid;
  perform set_config('request.jwt.claims', '', true);
  assert auth.uid() is null;
end $$;
