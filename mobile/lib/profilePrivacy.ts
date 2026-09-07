import type { AppRole } from './session';
import { floridaCityFromLocation, normalizeFloridaLocation } from './floridaLocation';

/** Optional reporting data must never gate marketplace access. */
export function normalizeOptionalGender(value: unknown): 'female' | 'male' | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'female' || value === 'male') return value;
  throw new Error('Choose Female, Male, or Prefer not to say.');
}

/** SDK 54 only needs the library permission for original/pass-through iOS video. */
export function needsMediaLibraryPermission(platform: string, kind: string): boolean {
  return platform === 'ios' && kind === 'video';
}

const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const hasItems = (value: unknown) => Array.isArray(value) && value.some(hasText);

export function isEligibleBirthDate(value: unknown, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const normalized = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const latest = new Date(now);
  latest.setFullYear(latest.getFullYear() - 16);
  latest.setHours(12, 0, 0, 0);
  return normalized === value && date <= latest;
}

export function getProfileReadiness(profile: Record<string, any>, role: AppRole) {
  const fields = role === 'barista'
    ? { display_name: 'Name', avatar_url: 'Profile picture', location: 'City', bio: 'About you', experience: 'Experience', availability: 'Availability', pay_expectation: 'Desired pay' }
    : { cafe_name: 'Café name', avatar_url: 'Café picture', location: 'City', bio: 'About your café', cafe_address: 'Café address', open_hours: 'Opening hours', shop_type: 'Shop type' };
  const missing = Object.entries(fields).filter(([key]) => !hasText(profile[key])).map(([, label]) => label as string);
  if (!hasItems(role === 'barista' ? profile.skills : profile.barista_preferences)) missing.push(role === 'barista' ? 'Skills' : 'Barista preferences');
  if (role === 'barista' && !isEligibleBirthDate(profile.date_of_birth)) missing.push('Private date of birth');
  const complete = missing.length === 0;
  return { complete, missing, visible: complete && profile.is_discoverable === true && profile.visible_to_cafes === true && !profile.suspended_at };
}

export function buildProfileUpdate(profile: Record<string, any>, role: AppRole, options: {
  locationCity: string; availability: string[]; availabilityNotes: string; openHours: string;
}) {
  const location = normalizeFloridaLocation(options.locationCity);
  if (!location) throw new Error('Enter a Florida city such as Miami.');
  const payload: Record<string, any> = {
    location, bio: String(profile.bio || '').trim() || null,
    avatar_url: profile.avatar_url || null, video_path: profile.video_path || null,
  };
  if (role === 'barista') {
    if (!isEligibleBirthDate(profile.date_of_birth)) throw new Error('Enter a valid date of birth (YYYY-MM-DD). You must be at least 16. This stays private.');
    normalizeOptionalGender(profile.gender_identity);
    const preferred = normalizeFloridaLocation(profile.preferred_city || options.locationCity);
    if (!preferred) throw new Error('Enter a valid preferred Florida city.');
    const zip = String(profile.preferred_postal_code || '').trim();
    if (zip && !/^\d{5}$/.test(zip)) throw new Error('Enter a five-digit preferred ZIP code, or leave it blank.');
    Object.assign(payload, {
      display_name: String(profile.display_name || '').trim() || null,
      experience: String(profile.experience || '').trim() || null,
      pay_expectation: String(profile.pay_expectation || '').trim() || null,
      availability: [...options.availability, options.availabilityNotes.trim()].filter(Boolean).join(' · ') || null,
      skills: String(profile.skills_text ?? profile.skills?.join(', ') ?? '').split(',').map(value => value.trim()).filter(Boolean),
      preferred_city: floridaCityFromLocation(preferred), preferred_state: 'FL', preferred_postal_code: zip || null,
    });
  } else {
    Object.assign(payload, {
      cafe_name: String(profile.cafe_name || '').trim() || null,
      cafe_address: String(profile.cafe_address || '').trim() || null,
      open_hours: options.openHours.trim() || null,
      shop_type: String(profile.shop_type || '').trim() || null,
      barista_preferences: (profile.barista_preferences || []).filter(hasText),
      bar_picture_url: profile.bar_picture_url || null,
    });
  }
  payload.is_discoverable = getProfileReadiness({ ...profile, ...payload }, role).complete && !profile.suspended_at;
  // Keep the saved opt-in. Actual visibility is confirmed from the returned row.
  return payload;
}

export async function persistProfileUpdate(client: any, userId: string, role: AppRole, payload: Record<string, any>, demographics: {
  date_of_birth: string; gender_identity: 'female' | 'male' | null;
}, assertCurrent: () => Promise<unknown>) {
  await assertCurrent();
  if (role === 'barista') {
    const { error } = await client.from('profile_demographics').upsert({
      user_id: userId, ...demographics, age_range: null, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw error;
  }
  await assertCurrent();
  const { data, error } = await client.from('profiles').update(payload).eq('id', userId).select('*').single();
  if (error) throw error;
  if (!data || data.id !== userId) throw new Error('The saved profile could not be confirmed. Please try again.');
  await assertCurrent();
  return data;
}
