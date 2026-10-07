/** Shared marketplace geography: 50 U.S. states and Washington, D.C. */
export const US_STATES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});
const clean = (value: unknown) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const names = Object.entries(US_STATES).sort((a, b) => b[1].length - a[1].length);
export function normalizeUSState(value: unknown): string {
  const text = clean(value).replace(/\./g, '').toUpperCase();
  return Object.hasOwn(US_STATES, text) ? text : names.find(([, name]) => name.toUpperCase() === text)?.[0] || '';
}
export function parseUSLocation(value: unknown, fallbackState: unknown = '') {
  let city = clean(value), postal = '', state = '';
  const zip = city.match(/(?:[\s,]+)(\d{5})(?:-\d{4})?$/);
  if (zip) { postal = zip[1]; city = city.slice(0, zip.index).replace(/[\s,]+$/, ''); }
  // A state name alone is not a city and state (notably West Virginia).
  if (normalizeUSState(city)) return null;
  const code = city.match(/^(.*?)(?:,\s*|\s+)([a-z]{2}|D\.C\.)$/i);
  if (code) { state = normalizeUSState(code[2]); if (!state) return null; city = code[1]; }
  else {
    const suffix = names.find(([, name]) => city.toLowerCase().endsWith(` ${name.toLowerCase()}`) || city.toLowerCase().endsWith(`,${name.toLowerCase()}`));
    if (suffix) { state = suffix[0]; city = city.slice(0, -(suffix[1].length + 1)); }
  }
  city = city.replace(/,\s*$/, '').trim();
  state ||= normalizeUSState(fallbackState);
  if (!state || !city || city.length > 80 || city.includes(',') || /[<>\r\n]/.test(city) || !/\p{L}/u.test(city)) return null;
  return { city, state, postal };
}
export function normalizeUSLocation(value: unknown, selectedState: unknown = '') {
  const state = normalizeUSState(selectedState);
  if (clean(selectedState) && !state) return null;
  const text = clean(value);
  if (/^[a-z]{2}$/i.test(text) && normalizeUSState(text)) return null;
  const postal = text.match(/(?:[\s,]+)(\d{5}(?:-\d{4})?)$/)?.[1] || '';
  const cityAndState = postal ? text.slice(0, -postal.length).replace(/[\s,]+$/, '') : text;
  const suffixCode = cityAndState.match(/\s+([a-z]{2}|D\.C\.)$/i)?.[1];
  // A final two-letter city word (Santa Fe) is not automatically a state.
  const structuredCity = state && !cityAndState.includes(',') && (!suffixCode || !normalizeUSState(suffixCode));
  const place = parseUSLocation(structuredCity ? `${cityAndState}, ${state}` : cityAndState, state);
  if (!place || (state && state !== place.state)) return null;
  // Preserve a supplied profile ZIP for existing café ZIP matching.
  return `${place.city}, ${place.state}${postal ? ` ${postal}` : ''}`;
}
export function cityFromUSLocation(value: unknown) { return parseUSLocation(value)?.city || clean(value); }
export const exactUSCity = (value: unknown) => clean(value).toLowerCase().replace(/[.,]/g, '');
export function usPlaceParts(value: unknown, fallbackState: unknown = '') {
  const place = parseUSLocation(value, fallbackState);
  return { city: exactUSCity(place?.city || ''), state: place?.state.toLowerCase() || '', postal: place?.postal || '' };
}
type AreaProfile = { location?: string | null; cafe_address?: string | null; preferred_city?: string | null; preferred_state?: string | null; preferred_postal_code?: string | null };
type AreaJob = { location?: string | null; city?: string | null; state?: string | null; postal_code?: string | null };
export function usWorkArea(profile: AreaProfile) {
  // A city-only stored profile predates nationwide signup and belonged to Florida.
  const home = parseUSLocation(profile.location, 'FL');
  const state = normalizeUSState(profile.preferred_state || home?.state || (!clean(profile.location) ? 'FL' : ''));
  const preferred = clean(profile.preferred_city) ? parseUSLocation(normalizeUSLocation(profile.preferred_city, state)) : home;
  const valid = !!state && (!clean(profile.preferred_city) || preferred?.state === state);
  return { city: valid ? exactUSCity(preferred?.city || home?.city) : '', state: valid ? state.toLowerCase() : '', postal: clean(profile.preferred_postal_code).replace(/-\d{4}$/, '') };
}
export function usWorkAreaLabel(profile: AreaProfile) {
  const area = usWorkArea(profile);
  if (!area.state || (area.postal && !/^\d{5}$/.test(area.postal))) return 'Set your work city, state or ZIP';
  return area.postal ? `ZIP ${area.postal}` : area.city ? `${area.city.replace(/\b[a-z]/g, c => c.toUpperCase())}, ${area.state.toUpperCase()}` : 'Set your work city, state or ZIP';
}
export function usJobMatchesWorkArea(profile: AreaProfile, job: AreaJob) {
  const area = usWorkArea(profile), legacy = parseUSLocation(job.location);
  const state = normalizeUSState(job.state || legacy?.state).toLowerCase(), city = exactUSCity(job.city || legacy?.city), postal = clean(job.postal_code || legacy?.postal).replace(/-\d{4}$/, '');
  if (!area.state || area.state !== state) return false;
  return area.postal ? /^\d{5}$/.test(area.postal) && area.postal === postal : !!area.city && area.city === city;
}
export function usCandidateMatchesCafe(cafeProfile: AreaProfile, candidate: AreaProfile) {
  const addressParts = clean(cafeProfile.cafe_address).split(',').map(part => part.trim());
  const trailingZip = /^\d{5}(?:-\d{4})?$/.test(addressParts.at(-1) || '');
  const cafe = parseUSLocation(cafeProfile.location, 'FL'), address = parseUSLocation(addressParts.slice(trailingZip ? -3 : -2).join(',')), area = usWorkArea(candidate);
  if (!cafe || area.state !== cafe.state.toLowerCase()) return false;
  return area.postal ? /^\d{5}$/.test(area.postal) && area.postal === (cafe.postal || (address?.state === cafe.state ? address.postal : '')) : !!area.city && exactUSCity(cafe.city) === area.city;
}
