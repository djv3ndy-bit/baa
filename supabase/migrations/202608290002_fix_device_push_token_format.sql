alter table public.device_push_tokens drop constraint if exists device_push_tokens_format_check;
alter table public.device_push_tokens add constraint device_push_tokens_format_check check (expo_push_token ~ '^Expo(nent)?PushToken[[][A-Za-z0-9_-]+[]]$');
