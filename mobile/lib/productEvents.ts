import { supabase } from './supabase';

export type ActivationEvent = 'signup_completed' | 'post_job_started' | 'job_posted' | 'job_viewed' | 'apply_started' | 'application_submitted';
const allowed = new Set<ActivationEvent>(['signup_completed','post_job_started','job_posted','job_viewed','apply_started','application_submitted']);

export async function trackProductEvent(eventName: ActivationEvent, metadata: Record<string, string> = {}) {
  if (!allowed.has(eventName)) return;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const safeMetadata = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => /^[a-z_]{1,40}$/.test(key) && typeof value === 'string').slice(0, 8).map(([key, value]) => [key, value.slice(0, 80)]));
    await supabase.from('product_events').insert({ user_id: user.id, event_name: eventName, metadata: safeMetadata });
  } catch {
    // Analytics must never block the user's product flow.
  }
}
