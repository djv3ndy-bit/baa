import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppRole } from './session';
import { jobMatchesWorkArea } from '@/lib/floridaLocation';
import { allMessageRows, unreadNotifications, UnreadNotification } from './messaging';

export type DashboardCounts = { jobs: number; matches: number; alerts: number; candidates: number; applications: number; messages: number };
export const emptyDashboardCounts: DashboardCounts = { jobs: 0, matches: 0, alerts: 0, candidates: 0, applications: 0, messages: 0 };

export function summarizeHome(userId: string, role: AppRole, profile: Record<string, any>, jobs: any[], applications: any[], interests: any[], matches: any[], notifications: UnreadNotification[]): DashboardCounts {
  return {
    jobs: role === 'barista' ? jobs.filter(job => jobMatchesWorkArea(profile, job)).length : jobs.length,
    matches: applications.filter(row => row.status === 'matched').length + matches.length,
    alerts: notifications.filter(row => !row.read_at).length,
    messages: notifications.filter(row => !row.read_at && row.type === 'message').length,
    applications: applications.length + interests.filter(row => row.sender_id === userId).length,
    candidates: role === 'cafe_owner_manager' ? applications.filter(row => row.status === 'interested').length + interests.filter(row => row.target_id === userId && !matches.some(match => match.barista_id === row.sender_id)).length : 0,
  };
}

export async function loadHomeSummary(client: SupabaseClient, userId: string, role: AppRole, profile: Record<string, any>) {
  const [jobs, applications, interests, matches, notifications] = await Promise.all([
    allMessageRows<any>(() => {
      const query = client.from('jobs').select('id,location,city,state,postal_code').eq('active', true);
      return (role === 'cafe_owner_manager' ? query.eq('owner_id', userId) : query).order('id');
    }),
    allMessageRows<any>(() => {
      const query = client.from('applications').select(`id,status,job:${role === 'barista' ? 'jobs' : 'jobs!inner'}(owner_id)`);
      return (role === 'barista' ? query.eq('barista_id', userId) : query.eq('job.owner_id', userId)).order('id');
    }),
    allMessageRows<any>(() => client.from('discovery_interests').select('id,sender_id,target_id').or(`sender_id.eq.${userId},target_id.eq.${userId}`).order('id')),
    allMessageRows<any>(() => client.from('discovery_matches').select('id,barista_id,cafe_id').eq(role === 'barista' ? 'barista_id' : 'cafe_id', userId).order('id')),
    unreadNotifications(client, userId),
  ]);
  return summarizeHome(userId, role, profile, jobs, applications, interests, matches, notifications);
}
