import type { AppRole } from '../../lib/session';
import type { DashboardCounts } from '../../lib/homeSummary';
import type { MarketJob } from '../../lib/marketplace';

export type Destination = { pathname: string; params?: Record<string, string> };
export type DashboardMatch = {
  id: string;
  kind: 'application' | 'discovery';
  name: string;
  detail: string;
  avatarUrl?: string | null;
};
export type DashboardData = {
  accountId: string;
  role: AppRole;
  counts: DashboardCounts;
  jobs: MarketJob[];
  matches: DashboardMatch[];
  location: string;
  profileProgress: number;
};

export function dashboardLinks(role: AppRole) {
  const cafe = role === 'cafe_owner_manager';
  return {
    primary: { pathname: cafe ? '/post-job' : '/discover' },
    jobs: { pathname: cafe ? '/jobs' : '/discover' },
    sent: { pathname: '/discover', params: { tab: 'sent' } },
    matches: { pathname: '/matches' },
    messages: { pathname: '/messages' },
  } satisfies Record<string, Destination>;
}

export function jobDestination(role: AppRole, id: string): Destination {
  return role === 'cafe_owner_manager'
    ? { pathname: '/post-job', params: { jobId: id } }
    : { pathname: '/discover', params: { jobId: id } };
}

export function matchDestination(match: Pick<DashboardMatch, 'id' | 'kind'>): Destination {
  return { pathname: '/chat/[id]', params: { id: match.id, kind: match.kind } };
}

export function countLabel(value: number): string {
  const count = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return count >= 10000 ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count) : String(count);
}

/** Select a factual status; notification delivery never implies a reply is owed. */
export function unreadLabel(count: number): string {
  return count === 1 ? '1 unread message' : `${count} unread messages`;
}

export function safeDashboardError(cause: unknown): string {
  const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
  if (status === 401) return 'Your session could not be confirmed. Sign in again to refresh your dashboard.';
  if (status === 403) return 'Your account cannot access these details. Open account settings or contact support.';
  return 'Your dashboard could not refresh. Check your connection and try again.';
}
