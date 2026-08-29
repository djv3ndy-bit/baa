create table if not exists public.device_push_tokens (
  expo_push_token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('ios','android')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_push_tokens_format_check check (expo_push_token ~ '^Expo(nent)?PushToken[[][A-Za-z0-9_-]+[]]$')
);

create index if not exists device_push_tokens_user_id_idx on public.device_push_tokens (user_id) where enabled = true;
alter table public.device_push_tokens enable row level security;
create policy "Users can view their push tokens" on public.device_push_tokens for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can register their push tokens" on public.device_push_tokens for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their push tokens" on public.device_push_tokens for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can remove their push tokens" on public.device_push_tokens for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.device_push_tokens from anon;
grant select, insert, update, delete on table public.device_push_tokens to authenticated;
