create table if not exists public.profile_demographics (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  age_range text check (age_range is null or age_range in ('16_17','18_24','25_34','35_44','45_54','55_plus','prefer_not_to_say')),
  gender_identity text check (gender_identity is null or gender_identity in ('woman','man','non_binary','another_identity','prefer_not_to_say')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profile_demographics enable row level security;

drop policy if exists "Members can read their own demographics" on public.profile_demographics;
create policy "Members can read their own demographics"
on public.profile_demographics for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Members can add their own demographics" on public.profile_demographics;
create policy "Members can add their own demographics"
on public.profile_demographics for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Members can update their own demographics" on public.profile_demographics;
create policy "Members can update their own demographics"
on public.profile_demographics for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on table public.profile_demographics from anon, authenticated;
grant select, insert, update on table public.profile_demographics to authenticated;
grant select, insert, update on table public.profile_demographics to service_role;

comment on table public.profile_demographics is 'Optional private member demographics used only for account-owner aggregate reporting.';
comment on column public.profile_demographics.age_range is 'Optional age band; never displayed on a marketplace profile.';
comment on column public.profile_demographics.gender_identity is 'Optional self-described gender category; never displayed on a marketplace profile.';

create or replace function public.owner_demographic_analytics()
returns jsonb
language sql
security definer
set search_path = public
as $$
with age_counts as (
  select case coalesce(d.age_range,'not_provided')
    when '16_17' then '16–17'
    when '18_24' then '18–24'
    when '25_34' then '25–34'
    when '35_44' then '35–44'
    when '45_54' then '45–54'
    when '55_plus' then '55+'
    when 'prefer_not_to_say' then 'Prefer not to say'
    else 'Not provided'
  end label, count(*)::int value
  from public.profiles p
  left join public.profile_demographics d on d.user_id=p.id
  group by coalesce(d.age_range,'not_provided')
), gender_counts as (
  select case coalesce(d.gender_identity,'not_provided')
    when 'woman' then 'Women'
    when 'man' then 'Men'
    when 'non_binary' then 'Non-binary'
    when 'another_identity' then 'Another identity'
    when 'prefer_not_to_say' then 'Prefer not to say'
    else 'Not provided'
  end label, count(*)::int value
  from public.profiles p
  left join public.profile_demographics d on d.user_id=p.id
  group by coalesce(d.gender_identity,'not_provided')
), role_completion as (
  select case p.role when 'barista' then 'Baristas' else 'Café owners' end label,
    count(*) filter (where d.age_range is not null or d.gender_identity is not null)::int value
  from public.profiles p
  left join public.profile_demographics d on d.user_id=p.id
  group by p.role
)
select jsonb_build_object(
  'metrics',jsonb_build_object(
    'members',(select count(*) from public.profiles),
    'profiles_with_demographics',(select count(*) from public.profile_demographics where age_range is not null or gender_identity is not null),
    'complete_profiles',(select count(*) from public.profile_demographics where age_range is not null and gender_identity is not null),
    'age_provided',(select count(*) from public.profile_demographics where age_range is not null and age_range<>'prefer_not_to_say'),
    'gender_provided',(select count(*) from public.profile_demographics where gender_identity is not null and gender_identity<>'prefer_not_to_say')
  ),
  'age_ranges',coalesce((select jsonb_agg(to_jsonb(age_counts) order by value desc,label) from age_counts),'[]'::jsonb),
  'gender_mix',coalesce((select jsonb_agg(to_jsonb(gender_counts) order by value desc,label) from gender_counts),'[]'::jsonb),
  'completion_by_role',coalesce((select jsonb_agg(to_jsonb(role_completion) order by label) from role_completion),'[]'::jsonb)
);
$$;

revoke execute on function public.owner_demographic_analytics() from public, anon, authenticated;
grant execute on function public.owner_demographic_analytics() to service_role;
