-- RLS does not restrict whole-table privileges such as TRUNCATE. Browser/mobile
-- clients need only explicitly granted CRUD/RPC access; preserve those grants.
revoke truncate, references, trigger, maintain
  on all tables in schema public from public, anon, authenticated;

-- Earlier CRUD-only default revokes left these privileges behind for tables
-- created by postgres. Keep future exposure opt-in without changing RPC defaults.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from public, anon, authenticated;
