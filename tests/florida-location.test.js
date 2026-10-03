import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
// Keep this root-only CI test independent of the mobile dependency installation.
const moduleSource = readFileSync(new URL('../mobile/lib/floridaLocation.ts', import.meta.url), 'utf8')
  .replace("'./usLocation'", JSON.stringify(new URL('../mobile/lib/usLocation.ts', import.meta.url).href));
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(moduleSource)).toString('base64')}`;
const { floridaCityFromLocation, normalizeFloridaLocation } = await import(moduleUrl);

test("accepts a city without requiring the user to type the state", () => {
  assert.equal(normalizeFloridaLocation("Miami"), "Miami, FL");
  assert.equal(normalizeFloridaLocation("  Fort   Lauderdale  "), "Fort Lauderdale, FL");
  assert.equal(normalizeFloridaLocation("Florida City"), "Florida City, FL");
});

test("normalizes supported Florida location formats", () => {
  assert.equal(normalizeFloridaLocation("Miami, FL"), "Miami, FL");
  assert.equal(normalizeFloridaLocation("Miami Florida"), "Miami, FL");
  assert.equal(normalizeFloridaLocation("Miami, FL 33101"), "Miami, FL");
});

test("rejects empty, state-only, and explicitly non-Florida values", () => {
  assert.equal(normalizeFloridaLocation(""), null);
  assert.equal(normalizeFloridaLocation("FL"), null);
  assert.equal(normalizeFloridaLocation("Miami, NY"), null);
  assert.equal(normalizeFloridaLocation("Miami NY"), null);
});

test("extracts the city for a city-only input field", () => {
  assert.equal(floridaCityFromLocation("St. Petersburg, FL"), "St. Petersburg");
  assert.equal(floridaCityFromLocation("Key West"), "Key West");
});
