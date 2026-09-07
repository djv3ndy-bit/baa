import { supabase } from './supabase';
import { authenticatedApi } from './api';
import { jobMatchesWorkArea, candidateMatchesCafe } from './floridaLocation';
import type { AppRole } from './session';

export type MarketProfile = {
  id: string; role?: AppRole; display_name?: string | null; cafe_name?: string | null;
  location?: string | null; avatar_url?: string | null; bio?: string | null;
  skills?: string[] | null; availability?: string | null; experience?: string | null;
  pay_expectation?: string | null; cafe_address?: string | null; open_hours?: string | null;
  shop_type?: string | null; barista_preferences?: string[] | null;
  preferred_city?: string | null; preferred_state?: string | null; preferred_postal_code?: string | null;
  video_path?: string | null; bar_picture_url?: string | null;
  is_discoverable?: boolean; suspended_at?: string | null;
};
export type MarketJob = {
  id: string; owner_id: string; title: string; location: string | null;
  city?: string | null; state?: string | null; postal_code?: string | null;
  address_line1?: string | null; address_line2?: string | null;
  pay_min: number | null; pay_max: number | null; schedule: string | null;
  description: string | null; required_skills: string[] | null; active: boolean;
  owner?: MarketProfile;
};
export type MarketApplication = { id: string; job_id: string; status: string; barista_id: string; job?: MarketJob; barista?: MarketProfile };
export type MarketInterest = { id: string; sender_id: string; target_id: string };
export type MarketMatch = { id: string; barista_id: string; cafe_id: string };
export type Marketplace = {
  jobs: MarketJob[]; requestedJob?: MarketJob | null; candidates: MarketProfile[]; applications: MarketApplication[];
  interests: MarketInterest[]; matches: MarketMatch[]; profiles: Record<string, MarketProfile>;
};
export const PUBLIC_PROFILE_FIELDS = 'id,role,display_name,cafe_name,location,avatar_url,bio,skills,availability,experience,pay_expectation,cafe_address,open_hours,shop_type,barista_preferences,preferred_city,preferred_state,preferred_postal_code,is_discoverable,suspended_at,video_path,bar_picture_url';
export const JOB_FIELDS = 'id,owner_id,title,location,city,state,postal_code,address_line1,address_line2,pay_min,pay_max,schedule,description,required_skills,active';

// Read every page before local geography filtering; a busy city must not hide later results.
export async function readAllRows<T>(query: () => any, pageSize = 200): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ;) {
    const { data, error } = await query().range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('The results could not be confirmed. Please refresh.');
    if (!data.length) return rows;
    rows.push(...data);
    // Supabase may enforce a server cap smaller than the requested page size.
    offset += data.length;
  }
}
export async function readProfiles(ids: string[]) {
  const unique = [...new Set(ids)], profiles: Record<string, MarketProfile> = {};
  for (let offset = 0; offset < unique.length; offset += 100) {
    const group = unique.slice(offset, offset + 100);
    const rows = await readAllRows<MarketProfile>(() => supabase.from('profiles').select(PUBLIC_PROFILE_FIELDS).in('id', group).order('id'));
    rows.forEach(profile => { profiles[profile.id] = profile; });
  }
  return profiles;
}
export async function loadApplications(userId: string, role: AppRole) {
  return readAllRows<MarketApplication>(() => {
    const jobJoin = role === 'barista' ? 'jobs!applications_job_id_fkey' : 'jobs!applications_job_id_fkey!inner';
    let query = supabase.from('applications').select(`id,job_id,barista_id,status,job:${jobJoin}(${JOB_FIELDS}),barista:profiles!applications_barista_id_fkey(${PUBLIC_PROFILE_FIELDS})`);
    query = role === 'barista' ? query.eq('barista_id', userId) : query.eq('job.owner_id', userId);
    return query.order('created_at', { ascending: false }).order('id');
  });
}
export async function loadMarketplace(userId: string, role: AppRole, profile: MarketProfile, requestedJobId?: string): Promise<Marketplace> {
  const [interests, matches, applications, allJobs, allCandidates, requestedJob] = await Promise.all([
    readAllRows<MarketInterest>(() => supabase.from('discovery_interests').select('id,sender_id,target_id').or(`sender_id.eq.${userId},target_id.eq.${userId}`).order('created_at', { ascending: false }).order('id')),
    readAllRows<MarketMatch>(() => supabase.from('discovery_matches').select('id,barista_id,cafe_id').or(`barista_id.eq.${userId},cafe_id.eq.${userId}`).order('created_at', { ascending: false }).order('id')),
    loadApplications(userId, role),
    role === 'barista' ? readAllRows<MarketJob>(() => supabase.from('jobs').select(JOB_FIELDS).eq('active', true).order('created_at', { ascending: false }).order('id')) : Promise.resolve([]),
    role === 'cafe_owner_manager' ? readAllRows<MarketProfile>(() => supabase.from('profiles').select(PUBLIC_PROFILE_FIELDS).eq('role', 'barista').eq('is_discoverable', true).eq('visible_to_cafes', true).neq('id', userId).order('updated_at', { ascending: false }).order('id')) : Promise.resolve([]),
    role === 'barista' && requestedJobId ? readRequestedJob(requestedJobId) : Promise.resolve(null),
  ]);
  const jobs = allJobs.filter(job => jobMatchesWorkArea(profile, job));
  const profiles = await readProfiles([
    ...interests.flatMap(interest => [interest.sender_id, interest.target_id]),
    ...matches.flatMap(match => [match.barista_id, match.cafe_id]),
    ...jobs.map(job => job.owner_id), ...(requestedJob ? [requestedJob.owner_id] : []), ...applications.map(app => app.job?.owner_id || '').filter(Boolean),
  ].filter(id => id !== userId));
  allCandidates.forEach(person => { profiles[person.id] = person; });
  return { requestedJob: requestedJob ? { ...requestedJob, owner: profiles[requestedJob.owner_id] } : null, jobs: jobs.map(job => ({ ...job, owner: profiles[job.owner_id] })), candidates: allCandidates.filter(person => candidateMatchesCafe(profile, person)), applications, interests, matches, profiles };
}
export function interestState(data: Pick<Marketplace, 'interests' | 'matches'>, userId: string, targetId: string) {
  const match = data.matches.find(row => row.barista_id === targetId || row.cafe_id === targetId);
  const sent = data.interests.some(row => row.sender_id === userId && row.target_id === targetId);
  const received = data.interests.some(row => row.target_id === userId && row.sender_id === targetId);
  return { match, sent, received, label: match ? 'Matched' : received ? (sent ? 'Finish matching' : 'Match back') : sent ? 'Interest sent' : 'Show interest', disabled: !!match || (sent && !received) };
}
export function applicationStatus(status: string) {
  return status === 'matched' ? 'Matched' : status === 'declined' ? 'Not selected' : status === 'interested' ? 'Application sent' : status.replace(/_/g, ' ');
}
export function formatJobPay(job: Pick<MarketJob, 'pay_min' | 'pay_max'>) {
  return job.pay_min != null && job.pay_max != null ? `$${job.pay_min}–$${job.pay_max}/hour` : job.pay_min != null ? `From $${job.pay_min}/hour` : job.pay_max != null ? `Up to $${job.pay_max}/hour` : 'Pay not listed';
}
export async function applyToMarketplaceJob(jobId: string, userId: string) {
  // An earlier request may have succeeded before a connection was interrupted.
  const readExisting = async () => {
    const { data, error } = await supabase.from('applications').select('id,status').eq('barista_id', userId).eq('job_id', jobId).maybeSingle();
    if (error) throw error;
    return data;
  };
  if (await readExisting()) return;
  try { await authenticatedApi('/apply-job', { job_id: jobId }, 'POST', userId); }
  catch (error) { if (await readExisting()) return; throw error; }
}

export async function readRequestedJob(id: string): Promise<MarketJob | null> {
  const { data, error } = await supabase.from('jobs').select(JOB_FIELDS).eq('id', id).eq('active', true).maybeSingle();
  if (error) throw error;
  return data;
}

export async function profileVideoUrl(path: string) {
  const { data, error } = await supabase.storage.from('coffee-videos').createSignedUrl(path, 300);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error('This video is not currently available.');
  return data.signedUrl;
}
