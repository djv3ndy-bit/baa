import { usWorkArea, usWorkAreaLabel, usJobMatchesWorkArea, usCandidateMatchesCafe } from './usLocation';
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
// Keep existing imports compatible while nationwide matching uses the shared rules.
export const savedWorkArea = usWorkArea;
export const workAreaLabel = usWorkAreaLabel;
export const jobMatchesWorkArea = usJobMatchesWorkArea;
export const candidateMatchesCafe = usCandidateMatchesCafe;
