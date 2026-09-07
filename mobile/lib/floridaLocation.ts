const FLORIDA_NAME_SUFFIX = /^(.*?)(?:,\s*|\s+)florida$/i;
const STATE_CODE_SUFFIX = /^(.*?)(?:,\s*|\s+)([a-z]{2})$/i;
const ZIP_SUFFIX = /\s+\d{5}(?:-\d{4})?$/;

function cleanLocation(value?: string | null) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function parseFloridaCity(value?: string | null) {
  const original = cleanLocation(value);
  if (!original) return null;

  let candidate = original.replace(ZIP_SUFFIX, "").trim();
  if (/^(fl|florida)$/i.test(candidate)) return null;

  const floridaName = candidate.match(FLORIDA_NAME_SUFFIX);
  if (floridaName) {
    candidate = floridaName[1];
  } else {
    const stateCode = candidate.match(STATE_CODE_SUFFIX);
    if (stateCode) {
      if (stateCode[2].toUpperCase() !== "FL") return null;
      candidate = stateCode[1];
    } else if (candidate.includes(",")) {
      return null;
    }
  }

  const city = candidate.replace(/,\s*$/, "").trim();
  if (!city || city.length > 80 || /\d/.test(city)) return null;
  return city;
}

export function normalizeFloridaLocation(value?: string | null) {
  const city = parseFloridaCity(value);
  return city ? `${city}, FL` : null;
}

export function floridaCityFromLocation(value?: string | null) {
  return parseFloridaCity(value) || cleanLocation(value);
}

type AreaProfile = { location?: string | null; cafe_address?: string | null; preferred_city?: string | null; preferred_state?: string | null; preferred_postal_code?: string | null };
type AreaJob = { location?: string | null; city?: string | null; state?: string | null; postal_code?: string | null };
const exactPlace = (value?: string | null) => cleanLocation(value).toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
export function floridaPlaceParts(value?: string | null) {
  let text = cleanLocation(value).toLowerCase(), postal = '';
  const zip = text.match(/(?:[\s,]+)(\d{5})(?:-\d{4})?$/);
  if (zip) { postal = zip[1]; text = text.slice(0, zip.index).replace(/[\s,]+$/, ''); }
  const state = text.match(/(?:^|[\s,]+)(fl|florida)$/);
  return { city: exactPlace(state ? text.slice(0, state.index) : text), state: state ? 'fl' : '', postal };
}
export function savedWorkArea(profile: AreaProfile) {
  const home = floridaPlaceParts(profile.location), preferred = floridaPlaceParts(profile.preferred_city);
  const state = exactPlace(profile.preferred_state || home.state || 'fl');
  return { city: preferred.city || home.city, state: state === 'florida' ? 'fl' : state, postal: String(profile.preferred_postal_code || '').trim().replace(/-\d{4}$/, '') };
}
export function workAreaLabel(profile: AreaProfile) {
  const area = savedWorkArea(profile);
  if (area.state !== 'fl' || (area.postal && !/^\d{5}$/.test(area.postal))) return 'Set your Florida work city or ZIP';
  return area.postal ? `ZIP ${area.postal}` : area.city ? `${area.city.replace(/\b[a-z]/g, letter => letter.toUpperCase())}, FL` : 'Set your Florida work city or ZIP';
}
export function jobMatchesWorkArea(profile: AreaProfile, job: AreaJob) {
  const area = savedWorkArea(profile), legacy = floridaPlaceParts(job.location);
  const state = exactPlace(job.state || legacy.state), city = exactPlace(job.city || legacy.city), postal = String(job.postal_code || legacy.postal).trim().replace(/-\d{4}$/, '');
  if (area.state !== 'fl' || !['fl', 'florida'].includes(state)) return false;
  return area.postal ? /^\d{5}$/.test(area.postal) && area.postal === postal : !!area.city && area.city === city;
}
export function candidateMatchesCafe(cafeProfile: AreaProfile, candidate: AreaProfile) {
  const cafe = floridaPlaceParts(cafeProfile.location), address = floridaPlaceParts(cafeProfile.cafe_address), area = savedWorkArea(candidate);
  if (cafe.state !== 'fl' || area.state !== 'fl') return false;
  return area.postal ? /^\d{5}$/.test(area.postal) && area.postal === (cafe.postal || address.postal) : !!cafe.city && cafe.city === area.city;
}
