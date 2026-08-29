create table if not exists public.push_event_log (
  event_key text primary key,
  created_at timestamptz not null default now()
);
alter table public.push_event_log enable row level security;
revoke all on table public.push_event_log from anon, authenticated;
