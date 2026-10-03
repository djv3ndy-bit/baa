export type CafeJobAccess = {
  free_job_id: string | null;
  free_job_expires_at: string | null;
  has_paid_access: boolean;
  can_create: boolean;
  active_job_count: number;
  server_time: string;
  clockOffset: number;
};
export async function loadCafeJobAccess(request: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<CafeJobAccess> {
  const { data, error } = await request();
  const value = data as CafeJobAccess | null;
  if (error || !value || typeof value.can_create !== 'boolean' || typeof value.has_paid_access !== 'boolean'
    || !Number.isFinite(Date.parse(value.server_time)) || !Number.isInteger(value.active_job_count)
    || (value.free_job_id !== null && (!value.free_job_id || !Number.isFinite(Date.parse(value.free_job_expires_at || ''))))) {
    throw new Error('We could not verify your job access. Please try again.');
  }
  return { ...value, clockOffset: Date.parse(value.server_time) - Date.now() };
}
export function freeJobExpired(jobId: string, access: CafeJobAccess | null): boolean {
  return !!access && !access.has_paid_access && access.free_job_id === jobId
    && Date.parse(access.free_job_expires_at || '') <= Date.now() + access.clockOffset;
}
export function freeJobNotice(jobId: string, access: CafeJobAccess | null): string {
  if (!access || access.has_paid_access || access.free_job_id !== jobId) return '';
  if (freeJobExpired(jobId, access)) return 'Free post expired. Pro is required to reopen it. Applicants and conversations stay saved.';
  return `Free post ends ${new Date(access.free_job_expires_at!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. Editing or pausing does not extend it.`;
}
export function jobAccessError(error: unknown): string {
  const item = error as { code?: string; message?: string } | null;
  if (item?.code === 'PJB05') return 'Your free post has reached its 30-day limit. Start or restore Pro to reopen it. Applicants and conversations stay saved.';
  if (item?.code === 'PJB01') return 'Your one free job has already been used. An active Pro membership is required to post another job.';
  if (item?.code === 'PJB04') return 'You already have 3 active jobs. Pause one before publishing another.';
  return error instanceof Error ? error.message : 'We could not update this job. Please try again.';
}
