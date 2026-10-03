// Generated from mobile/lib/usLocation.ts by scripts/build-us-location.mjs.
(function () {
const exports = {};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exactUSCity = exports.US_STATES = void 0;
exports.normalizeUSState = normalizeUSState;
exports.parseUSLocation = parseUSLocation;
exports.normalizeUSLocation = normalizeUSLocation;
exports.cityFromUSLocation = cityFromUSLocation;
exports.usPlaceParts = usPlaceParts;
exports.usWorkArea = usWorkArea;
exports.usWorkAreaLabel = usWorkAreaLabel;
exports.usJobMatchesWorkArea = usJobMatchesWorkArea;
exports.usCandidateMatchesCafe = usCandidateMatchesCafe;
/** Shared marketplace geography: 50 U.S. states and Washington, D.C. */
exports.US_STATES = Object.freeze({
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});
const clean = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const names = Object.entries(exports.US_STATES).sort((a, b) => b[1].length - a[1].length);
function normalizeUSState(value) {
    const text = clean(value).replace(/\./g, '').toUpperCase();
    return Object.hasOwn(exports.US_STATES, text) ? text : names.find(([, name]) => name.toUpperCase() === text)?.[0] || '';
}
function parseUSLocation(value, fallbackState = '') {
    let city = clean(value), postal = '', state = '';
    const zip = city.match(/(?:[\s,]+)(\d{5})(?:-\d{4})?$/);
    if (zip) {
        postal = zip[1];
        city = city.slice(0, zip.index).replace(/[\s,]+$/, '');
    }
    const code = city.match(/^(.*?)(?:,\s*|\s+)([a-z]{2}|D\.C\.)$/i);
    if (code) {
        state = normalizeUSState(code[2]);
        if (!state)
            return null;
        city = code[1];
    }
    else {
        const suffix = names.find(([, name]) => city.toLowerCase().endsWith(` ${name.toLowerCase()}`) || city.toLowerCase().endsWith(`,${name.toLowerCase()}`));
        if (suffix) {
            state = suffix[0];
            city = city.slice(0, -(suffix[1].length + 1));
        }
    }
    city = city.replace(/,\s*$/, '').trim();
    state ||= normalizeUSState(fallbackState);
    if (!state || !city || city.length > 80 || city.includes(',') || /[<>\r\n]/.test(city) || !/\p{L}/u.test(city))
        return null;
    return { city, state, postal };
}
function normalizeUSLocation(value, selectedState = '') {
    const state = normalizeUSState(selectedState);
    if (clean(selectedState) && !state)
        return null;
    const text = clean(value);
    if (/^[a-z]{2}$/i.test(text) && normalizeUSState(text))
        return null;
    const structuredCity = state && !text.includes(',') && !/\s+[a-z]{2}$/i.test(text);
    const place = parseUSLocation(structuredCity ? `${text}, ${state}` : value, state);
    return place && (!state || state === place.state) ? `${place.city}, ${place.state}` : null;
}
function cityFromUSLocation(value) { return parseUSLocation(value)?.city || clean(value); }
const exactUSCity = (value) => clean(value).toLowerCase().replace(/[.,]/g, '');
exports.exactUSCity = exactUSCity;
function usPlaceParts(value, fallbackState = '') {
    const place = parseUSLocation(value, fallbackState);
    return { city: (0, exports.exactUSCity)(place?.city || ''), state: place?.state.toLowerCase() || '', postal: place?.postal || '' };
}
function usWorkArea(profile) {
    // A city-only stored profile predates nationwide signup and belonged to Florida.
    const home = parseUSLocation(profile.location, 'FL');
    const state = normalizeUSState(profile.preferred_state || home?.state || (!clean(profile.location) ? 'FL' : ''));
    const preferred = clean(profile.preferred_city) ? parseUSLocation(normalizeUSLocation(profile.preferred_city, state)) : home;
    const valid = !!state && (!clean(profile.preferred_city) || preferred?.state === state);
    return { city: valid ? (0, exports.exactUSCity)(preferred?.city || home?.city) : '', state: valid ? state.toLowerCase() : '', postal: clean(profile.preferred_postal_code).replace(/-\d{4}$/, '') };
}
function usWorkAreaLabel(profile) {
    const area = usWorkArea(profile);
    if (!area.state || (area.postal && !/^\d{5}$/.test(area.postal)))
        return 'Set your work city, state or ZIP';
    return area.postal ? `ZIP ${area.postal}` : area.city ? `${area.city.replace(/\b[a-z]/g, c => c.toUpperCase())}, ${area.state.toUpperCase()}` : 'Set your work city, state or ZIP';
}
function usJobMatchesWorkArea(profile, job) {
    const area = usWorkArea(profile), legacy = parseUSLocation(job.location);
    const state = normalizeUSState(job.state || legacy?.state).toLowerCase(), city = (0, exports.exactUSCity)(job.city || legacy?.city), postal = clean(job.postal_code || legacy?.postal).replace(/-\d{4}$/, '');
    if (!area.state || area.state !== state)
        return false;
    return area.postal ? /^\d{5}$/.test(area.postal) && area.postal === postal : !!area.city && area.city === city;
}
function usCandidateMatchesCafe(cafeProfile, candidate) {
    const cafe = parseUSLocation(cafeProfile.location, 'FL'), address = parseUSLocation(clean(cafeProfile.cafe_address).split(',').slice(-2).join(',')), area = usWorkArea(candidate);
    if (!cafe || area.state !== cafe.state.toLowerCase())
        return false;
    return area.postal ? /^\d{5}$/.test(area.postal) && area.postal === (cafe.postal || (address?.state === cafe.state ? address.postal : '')) : !!area.city && (0, exports.exactUSCity)(cafe.city) === area.city;
}

window.BaristaMatchLocation = Object.freeze(exports);
})();
