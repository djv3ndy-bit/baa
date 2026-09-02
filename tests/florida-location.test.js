import test from "node:test";
import assert from "node:assert/strict";
import {
  floridaCityFromLocation,
  normalizeFloridaLocation,
} from "../mobile/lib/floridaLocation.ts";

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
