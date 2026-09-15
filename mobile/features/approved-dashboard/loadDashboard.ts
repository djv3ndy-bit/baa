import { supabase } from '../../lib/supabase';
import { getCurrentContext, requireCurrentUser } from '../../lib/session';
import { loadHomeSummary } from '../../lib/homeSummary';
import { JOB_FIELDS, loadApplications, readAllRows, readProfiles, type MarketJob, type MarketMatch } from '../../lib/marketplace';
import { jobMatchesWorkArea, workAreaLabel } from '../../lib/floridaLocation';
import { getProfileReadiness } from '../../lib/profilePrivacy';
import { withMessageDeadline } from '../../lib/messaging';
import type { DashboardData, DashboardMatch } from './model';

export class DashboardSessionError extends Error {
  constructor(readonly destination: '/login' | '/signup') { super('Account setup required'); }
}

export async function loadDashboard(): Promise<DashboardData> {
  const context = await withMessageDeadline(getCurrentContext());
  if (!context.user) throw new DashboardSessionError('/login');
  if (!context.role || !context.profile) throw new DashboardSessionError('/signup');
  const { user, role, profile } = context;
  const cafe = role === 'cafe_owner_manager';
  const [counts, allJobs, applications, mutual, demographics] = await withMessageDeadline(Promise.all([
    loadHomeSummary(supabase, user.id, role, profile),
    readAllRows<MarketJob>(() => {
      const query = supabase.from('jobs').select(JOB_FIELDS).eq('active', true);
      return (cafe ? query.eq('owner_id', user.id) : query).order('created_at', { ascending: false }).order('id');
    }),
    loadApplications(user.id, role),
    readAllRows<MarketMatch>(() => supabase.from('discovery_matches').select('id,barista_id,cafe_id')
      .eq(cafe ? 'cafe_id' : 'barista_id', user.id).order('created_at', { ascending: false }).order('id')),
    cafe ? Promise.resolve({ data: null, error: null }) : supabase.from('profile_demographics').select('date_of_birth').eq('user_id', user.id).maybeSingle(),
  ]));
  if (demographics.error) throw demographics.error;
  const jobs = (cafe ? allJobs : allJobs.filter(job => jobMatchesWorkArea(profile, job))).slice(0, 2);
  const matchedApplications = applications.filter(row => row.status === 'matched');
  const profiles = await withMessageDeadline(readProfiles([
    ...jobs.map(job => job.owner_id),
    ...mutual.slice(0, 2).map(row => cafe ? row.barista_id : row.cafe_id),
    ...matchedApplications.slice(0, 2).map(row => cafe ? row.barista_id : row.job?.owner_id || ''),
  ].filter(Boolean)));
  const mutualRows: DashboardMatch[] = mutual.slice(0, 2).map(row => {
    const person = profiles[cafe ? row.barista_id : row.cafe_id];
    return { id: row.id, kind: 'discovery', name: (cafe ? person?.display_name : person?.cafe_name) || 'Profile unavailable',
      detail: cafe ? [person?.experience, person?.skills?.slice(0, 2).join(', ')].filter(Boolean).join(' · ') || 'Mutual profile match' : 'Mutual profile match', avatarUrl: person?.avatar_url };
  });
  const applicationRows: DashboardMatch[] = matchedApplications.slice(0, 2).map(row => {
    const person = profiles[cafe ? row.barista_id : row.job?.owner_id || ''];
    return { id: row.id, kind: 'application', name: (cafe ? person?.display_name : person?.cafe_name) || 'Profile unavailable',
      detail: `${row.job?.title || 'Role unavailable'} · Matched`, avatarUrl: person?.avatar_url };
  });
  // Both matching systems retain their own conversation IDs. No unconfirmed
  // interest is promoted to a mutual match, and no fabricated match date is shown.
  const matches = [...applicationRows, ...mutualRows].slice(0, 2);
  const readiness = getProfileReadiness({ ...profile, date_of_birth: demographics.data?.date_of_birth }, role);
  const required = cafe ? 8 : 9;
  await requireCurrentUser(user.id);
  return { accountId: user.id, role, counts, jobs: jobs.map(job => ({ ...job, owner: profiles[job.owner_id] })), matches,
    location: cafe ? profile.location || '' : workAreaLabel(profile),
    profileProgress: Math.max(0, Math.min(100, Math.round((required - readiness.missing.length) / required * 100))) };
}
