import { supabase } from './supabase';
import { isSignupConfirmationCallback } from './authCallback';

export type ActivationEvent = 'signup_completed' | 'post_job_started' | 'job_posted' | 'job_viewed' | 'apply_started' | 'application_submitted';
const allowed = new Set<ActivationEvent>(['signup_completed','post_job_started','job_posted','job_viewed','apply_started','application_submitted']);

type EventResult = 'recorded' | 'duplicate' | 'skipped' | 'failed';
type FailureReason = 'auth_unavailable' | 'schema_mismatch' | 'permission_denied' | 'insert_failed' | 'request_failed';

function reportFailure(eventName: ActivationEvent, reason: FailureReason) {
  // Never log user IDs, tokens, payloads, or Supabase error text/details.
  try { console.warn('[product_events]', { event: eventName, reason }); } catch { /* Best effort only. */ }
}

export async function trackProductEvent(
  eventName: ActivationEvent,
  metadata: Record<string, unknown> = {},
  expectedUserId?: string,
): Promise<EventResult> {
  if (!allowed.has(eventName)) return 'skipped';
  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError) { reportFailure(eventName, 'auth_unavailable'); return 'failed'; }
    if (!user || (expectedUserId && user.id !== expectedUserId)) return 'skipped';
    // Only controlled enum values belong in analytics. Truncating arbitrary
    // strings does not remove PII (names, email, location, or free text).
    const safeMetadata: Record<string, string> = { surface: 'mobile' };
    if (metadata.role === 'barista' || metadata.role === 'cafe_owner_manager') safeMetadata.role = metadata.role;
    const { error } = await supabase.from('product_events').insert({ user_id: user.id, event_name: eventName, metadata: safeMetadata });
    if (error) {
      // Plain INSERT preserves insert-only RLS: no SELECT or UPDATE is needed.
      if (eventName === 'signup_completed' && error.code === '23505' && error.message?.includes('"product_events_signup_completed_user_idx"')) return 'duplicate';
      const reason = error.code === 'PGRST204' || error.code === '42703' ? 'schema_mismatch'
        : error.code === '42501' ? 'permission_denied' : 'insert_failed';
      reportFailure(eventName, reason);
      return 'failed';
    }
    return 'recorded';
  } catch {
    // Analytics must never block the user's product flow.
    reportFailure(eventName, 'request_failed');
    return 'failed';
  }
}

export async function trackConfirmedEmailSignup(
  url: string | null,
  user: { id: string; email_confirmed_at?: string },
  role: unknown,
): Promise<EventResult> {
  if (!isSignupConfirmationCallback(url) || !user.email_confirmed_at || (role !== 'barista' && role !== 'cafe_owner_manager')) return 'skipped';
  return trackProductEvent('signup_completed', { role }, user.id);
}
