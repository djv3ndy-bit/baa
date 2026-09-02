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
