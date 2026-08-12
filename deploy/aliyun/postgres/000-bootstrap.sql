\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'timing_authenticator') then
    create role timing_authenticator login noinherit;
  end if;
end
$$;

alter role service_role bypassrls;
alter role timing_authenticator login noinherit password :'authenticator_password';
grant anon, authenticated, service_role to timing_authenticator;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists timing_migrations;
create table if not exists timing_migrations.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default clock_timestamp()
);
