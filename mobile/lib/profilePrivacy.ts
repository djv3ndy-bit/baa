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
