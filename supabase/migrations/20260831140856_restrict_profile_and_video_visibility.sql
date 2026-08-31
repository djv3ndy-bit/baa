create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.can_view_profile(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles viewer
    join public.profiles target on target.id = target_user_id
    where viewer.id = (select auth.uid())
      and (
        target.id = viewer.id
        or (
          viewer.suspended_at is null
          and target.suspended_at is null
          and (
            (
              target.is_discoverable = true
              and (
                (viewer.role = 'barista' and target.role = 'cafe_owner_manager')
                or (
                  viewer.role = 'cafe_owner_manager'
                  and target.role = 'barista'
                  and public.cafe_has_hiring_access(viewer.id)
                )
              )
            )
            or (
              viewer.role = 'barista'
              and target.role = 'cafe_owner_manager'
              and exists (
                select 1
                from public.jobs job
                where job.owner_id = target.id
                  and job.active = true
              )
            )
            or exists (
              select 1
              from public.applications application
              join public.jobs job on job.id = application.job_id
              where (
                viewer.role = 'barista'
                and application.barista_id = viewer.id
                and job.owner_id = target.id
              )
              or (
                viewer.role = 'cafe_owner_manager'
                and job.owner_id = viewer.id
                and application.barista_id = target.id
                and public.cafe_has_hiring_access(viewer.id)
              )
            )
            or exists (
              select 1
              from public.discovery_matches discovery_match
              where (
                viewer.role = 'barista'
                and discovery_match.barista_id = viewer.id
                and discovery_match.cafe_id = target.id
              )
              or (
                viewer.role = 'cafe_owner_manager'
                and discovery_match.cafe_id = viewer.id
                and discovery_match.barista_id = target.id
                and public.cafe_has_hiring_access(viewer.id)
              )
            )
            or (
              viewer.role = 'barista'
              and target.role = 'cafe_owner_manager'
              and exists (
                select 1
                from public.profile_views profile_view
                where profile_view.viewed_profile_id = viewer.id
                  and profile_view.viewer_id = target.id
              )
            )
          )
        )
      )
  );
$$;

revoke all on function private.can_view_profile(uuid) from public;
grant execute on function private.can_view_profile(uuid) to authenticated;

comment on function private.can_view_profile(uuid) is
  'Returns whether the signed-in member may read the requested profile through discovery or an existing marketplace relationship.';

drop policy if exists "Authenticated users can view profiles" on public.profiles;
create policy "Members can view permitted profiles"
on public.profiles
for select
to authenticated
using (private.can_view_profile(id));

drop policy if exists "Authenticated users can view coffee videos" on storage.objects;
create policy "Members can view permitted coffee videos"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'coffee-videos'
  and (
    owner_id = ((select auth.uid()))::text
    or (storage.foldername(name))[1] = ((select auth.uid()))::text
    or exists (
      select 1
      from public.profiles profile
      where profile.id::text = (storage.foldername(name))[1]
        and private.can_view_profile(profile.id)
    )
  )
);
