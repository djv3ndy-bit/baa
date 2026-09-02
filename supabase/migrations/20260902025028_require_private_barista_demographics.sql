alter table public.profile_demographics
  add column if not exists date_of_birth date;

update public.profile_demographics
set gender_identity = case gender_identity
  when 'woman' then 'female'
  when 'man' then 'male'
  else null
end;

alter table public.profile_demographics
  drop constraint if exists profile_demographics_gender_identity_check;

alter table public.profile_demographics
  add constraint profile_demographics_gender_identity_check
  check (gender_identity is null or gender_identity in ('female', 'male'));

alter table public.profile_demographics
  drop constraint if exists profile_demographics_date_of_birth_check;

alter table public.profile_demographics
  add constraint profile_demographics_date_of_birth_check
  check (date_of_birth is null or (date_of_birth >= date '1920-01-01' and date_of_birth <= current_date));

comment on column public.profile_demographics.date_of_birth is
  'Private barista date of birth used for age eligibility and aggregate age bands; never exposed on marketplace profiles.';
comment on column public.profile_demographics.gender_identity is
  'Private barista demographic value limited to female or male; never exposed on marketplace profiles.';
comment on column public.profile_demographics.age_range is
  'Deprecated legacy age band. New age bands are calculated from private date_of_birth.';

create or replace function public.owner_demographic_analytics()
returns jsonb
language sql
security definer
set search_path = public
as $$
with barista_demographics as (
  select p.id,
    d.date_of_birth,
    d.gender_identity,
    case when d.date_of_birth is null then null
      else date_part('year', age(current_date, d.date_of_birth))::int
    end as age_years
  from public.profiles p
  left join public.profile_demographics d on d.user_id = p.id
  where p.role = 'barista'
), age_counts as (
  select case
    when age_years between 16 and 17 then '16–17'
    when age_years between 18 and 24 then '18–24'
    when age_years between 25 and 34 then '25–34'
    when age_years between 35 and 44 then '35–44'
    when age_years between 45 and 54 then '45–54'
    when age_years >= 55 then '55+'
    else 'Not provided'
  end label, count(*)::int value
  from barista_demographics
  group by 1
), gender_counts as (
  select case gender_identity
    when 'female' then 'Female'
    when 'male' then 'Male'
    else 'Not provided'
  end label, count(*)::int value
  from barista_demographics
  group by 1
)
select jsonb_build_object(
  'metrics', jsonb_build_object(
    'members', (select count(*) from public.profiles),
    'profiles_with_demographics', (select count(*) from barista_demographics where date_of_birth is not null or gender_identity is not null),
    'complete_profiles', (select count(*) from barista_demographics where date_of_birth is not null and gender_identity is not null),
    'age_provided', (select count(*) from barista_demographics where date_of_birth is not null),
    'gender_provided', (select count(*) from barista_demographics where gender_identity is not null)
  ),
  'age_ranges', coalesce((select jsonb_agg(to_jsonb(age_counts) order by value desc, label) from age_counts), '[]'::jsonb),
  'gender_mix', coalesce((select jsonb_agg(to_jsonb(gender_counts) order by value desc, label) from gender_counts), '[]'::jsonb),
  'completion_by_role', jsonb_build_array(jsonb_build_object(
    'label', 'Baristas',
    'value', (select count(*) from barista_demographics where date_of_birth is not null and gender_identity is not null)
  ))
);
$$;

revoke execute on function public.owner_demographic_analytics() from public, anon, authenticated;
grant execute on function public.owner_demographic_analytics() to service_role;
