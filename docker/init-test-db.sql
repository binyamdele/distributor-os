-- Runs once, when the Postgres volume is first initialised.
--
-- Two things happen here, and the second is a security control rather than convenience.

-- 1. The integration tests need their own database so they can truncate freely.
CREATE DATABASE distributor_os_test OWNER distributor;

-- 2. A non-superuser role for the application to connect as.
--
--    This is what makes Row-Level Security real. Postgres superusers bypass RLS
--    unconditionally, so if the application connected as the owning superuser, every policy
--    written in the migrations would be decorative. Migrations run as the owner
--    (DIRECT_URL); the application runs as this role (DATABASE_URL), and RLS applies to it.
CREATE ROLE distributor_app WITH LOGIN PASSWORD 'distributor_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE distributor_os TO distributor_app;
GRANT CONNECT ON DATABASE distributor_os_test TO distributor_app;

\connect distributor_os
GRANT USAGE ON SCHEMA public TO distributor_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO distributor_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO distributor_app;
-- Tables created by future migrations are covered without another grant.
ALTER DEFAULT PRIVILEGES FOR ROLE distributor IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO distributor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE distributor IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO distributor_app;

\connect distributor_os_test
GRANT USAGE ON SCHEMA public TO distributor_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO distributor_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO distributor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE distributor IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO distributor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE distributor IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO distributor_app;
