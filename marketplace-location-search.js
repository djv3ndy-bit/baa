// Website-only search geography. Postal centers are approximate, not street locations.
(function () {
  'use strict';

  const geography = window.BaristaMatchLocation;
  const clean = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const cityKey = value => geography.exactUSCity(value);
  const placeKey = (state, city) => `${state}:${cityKey(city)}`;
  const postalCode = value => /^\d{5}(?:-\d{4})?$/.test(clean(value)) ? clean(value).slice(0, 5) : '';
  const radiusOptions = new Set([10, 25, 50, 100]);

  function distanceMiles(first, second) {
    const radians = degrees => degrees * Math.PI / 180;
    const latitudeDifference = radians(second.latitude - first.latitude);
    const longitudeDifference = radians(second.longitude - first.longitude);
    const value = Math.sin(latitudeDifference / 2) ** 2
      + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude))
      * Math.sin(longitudeDifference / 2) ** 2;
    return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, value)));
  }

  function centerOf(points) {
    // Average Cartesian coordinates so Alaska's date-line ZIPs remain in Alaska.
    let x = 0, y = 0, z = 0;
    for (const point of points) {
      const latitude = point.latitude * Math.PI / 180;
      const longitude = point.longitude * Math.PI / 180;
      x += Math.cos(latitude) * Math.cos(longitude);
      y += Math.cos(latitude) * Math.sin(longitude);
      z += Math.sin(latitude);
    }
    return {
      latitude: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI,
      longitude: Math.atan2(y, x) * 180 / Math.PI
    };
  }

  function createIndex(data) {
    if (!Array.isArray(data?.rows)) throw new Error('The search location data could not be read.');
    const postalGroups = new Map(), cityGroups = new Map();
    for (const row of data.rows) {
      if (!Array.isArray(row)) continue;
      const [postal, city, stateValue, latitude, longitude] = row;
      const state = geography.normalizeUSState(stateValue);
      if (!state || !postalCode(postal) || !clean(city) || !Number.isFinite(latitude)
        || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
      const point = { postal: postalCode(postal), city: clean(city), state, latitude, longitude };
      const zipKey = `${state}:${point.postal}`, key = placeKey(state, city);
      if (!postalGroups.has(zipKey)) postalGroups.set(zipKey, []);
      if (!cityGroups.has(key)) cityGroups.set(key, []);
      postalGroups.get(zipKey).push(point);
      cityGroups.get(key).push(point);
    }
    const postals = new Map(), cities = new Map();
    for (const [key, points] of postalGroups) postals.set(key, { ...points[0], ...centerOf(points) });
    for (const [key, points] of cityGroups) {
      const center = centerOf(points);
      // Repeated place names in distant counties need a ZIP to disambiguate them.
      const ambiguous = points.some(point => distanceMiles(center, point) > 50);
      cities.set(key, { city: points[0].city, state: points[0].state, ...center, ambiguous });
    }
    return { postals, cities };
  }

  function parseSearchPlace(value, state) {
    const text = clean(value);
    const postal = postalCode(text);
    if (postal) return { city: '', postal };
    const normalized = geography.normalizeUSLocation(text, state);
    const parsed = normalized && geography.parseUSLocation(normalized);
    if (!parsed || parsed.state !== state) throw new Error('Enter a city or ZIP in the selected state.');
    return { city: parsed.city, postal: parsed.postal };
  }

  function pointFor(index, place) {
    if (!index) return null;
    if (place.postal) return index.postals.get(`${place.state}:${place.postal}`) || null;
    const city = index.cities.get(placeKey(place.state, place.city));
    return city && !city.ambiguous ? city : null;
  }

  function resolveSearch(index, options) {
    const state = geography.normalizeUSState(options.state);
    if (!state) throw new Error('Choose a U.S. state.');
    const requestedRadius = options.radius ?? 25;
    const radius = ['city', 'state'].includes(requestedRadius) ? requestedRadius : Number(requestedRadius);
    if (!['city', 'state'].includes(radius) && !radiusOptions.has(radius)) throw new Error('Choose a distance from the list.');
    const sameState = options.sameState !== false;
    if (radius === 'state') return { state, place: '', city: '', postal: '', radius, sameState: true, center: null, label: `Anywhere in ${geography.US_STATES[state]}` };
    const parsed = parseSearchPlace(options.place, state);
    const target = { ...parsed, state };
    const center = pointFor(index, target);
    if (parsed.postal && index && !center) throw new Error('That ZIP is unavailable in the selected state. Try another ZIP or city.');
    if (typeof radius === 'number' && !center) throw new Error('Choose a nearby ZIP for this city, or use city or statewide search.');
    const city = center?.city || parsed.city;
    const placeLabel = parsed.postal ? `${city ? `${city}, ` : ''}${state} ${parsed.postal}` : `${city}, ${state}`;
    return {
      state, place: parsed.postal || city, city: cityKey(parsed.city || center?.city), postal: parsed.postal,
      radius, sameState, center,
      label: radius === 'city' ? `${parsed.postal ? 'ZIP ' + parsed.postal : city}, ${state}` : `Within ${radius} miles of ${placeLabel}`
    };
  }

  function jobPlace(job) {
    const legacy = geography.parseUSLocation(job.location);
    return {
      state: geography.normalizeUSState(job.state || legacy?.state),
      city: cityKey(job.city || legacy?.city),
      postal: clean(job.postal_code || legacy?.postal).replace(/-\d{4}$/, '')
    };
  }

  function baristaPlace(profile) {
    const area = geography.usWorkArea(profile);
    return { city: area.city, state: geography.normalizeUSState(area.state), postal: area.postal };
  }

  function filterResults(index, search, rows, role) {
    const distances = new Map(), matches = [];
    let unlocatedCount = 0;
    for (const row of rows) {
      const place = role === 'barista' ? jobPlace(row) : baristaPlace(row);
      if (search.radius === 'state') {
        if (place.state === search.state) matches.push(row);
        continue;
      }
      if (search.radius === 'city') {
        if (place.state === search.state && (search.postal ? place.postal === search.postal : place.city === search.city)) matches.push(row);
        continue;
      }
      if (search.sameState && place.state && place.state !== search.state) continue;
      const point = pointFor(index, place);
      if (!point) {
        unlocatedCount++;
        continue;
      }
      const miles = distanceMiles(search.center, point);
      if (miles <= search.radius) {
        matches.push(row);
        distances.set(row.id, miles);
      }
    }
    if (typeof search.radius === 'number') matches.sort((first, second) => distances.get(first.id) - distances.get(second.id));
    return { rows: matches, distances, unlocatedCount };
  }

  window.BaristaMatchSearchLocation = Object.freeze({ createIndex, resolveSearch, filterResults, jobPlace, baristaPlace });
})();
