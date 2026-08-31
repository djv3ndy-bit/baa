alter table public.support_tickets
  drop constraint if exists support_tickets_status_check;

update public.support_tickets
set status = case status
  when 'investigating' then 'in_progress'
  when 'fixed' then 'resolved'
  else status
end
where status in ('investigating', 'fixed');

alter table public.support_tickets
  add constraint support_tickets_status_check
  check (status in ('new', 'in_progress', 'waiting_user', 'resolved', 'closed'));
