/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { GOOGLE_PLACE_ID_PATTERN, isGooglePlaceID } from "@mailwoman/spatial"
import { expect, test } from "vitest"

// A Google Place ID is a non-empty string of base64url-style characters: letters, digits, "_", "-".
// The pattern is anchored end-to-end, so any other character (or an empty string) is rejected.

test("isGooglePlaceID: a real 27-char Place ID is accepted", () => {
	// Google's documented example ID for the Sydney Opera House.
	expect(isGooglePlaceID("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(true)
})

test("isGooglePlaceID: underscores and dashes are valid characters", () => {
	expect(isGooglePlaceID("a_b-c_D-9")).toBe(true)
	expect(isGooglePlaceID("____")).toBe(true)
	expect(isGooglePlaceID("----")).toBe(true)
})

test("isGooglePlaceID: alphanumerics of any length are accepted", () => {
	expect(isGooglePlaceID("a")).toBe(true)
	expect(isGooglePlaceID("ABC123xyz")).toBe(true)
})

test("isGooglePlaceID: an empty string is rejected (minLength 1)", () => {
	expect(isGooglePlaceID("")).toBe(false)
})

test("isGooglePlaceID: characters outside [A-Za-z0-9_-] are rejected", () => {
	expect(isGooglePlaceID("has space")).toBe(false)
	expect(isGooglePlaceID("has.dot")).toBe(false)
	expect(isGooglePlaceID("plus+sign")).toBe(false)
	expect(isGooglePlaceID("slash/here")).toBe(false)
	expect(isGooglePlaceID("equals=pad")).toBe(false)
	expect(isGooglePlaceID("emoji😀")).toBe(false)
})

test("isGooglePlaceID: the pattern is fully anchored (a bad char anywhere fails)", () => {
	// A leading or trailing invalid character must fail even when the rest is valid — proving the
	// regex is anchored at both ends rather than merely "contains a valid run".
	expect(isGooglePlaceID(" ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(false)
	expect(isGooglePlaceID("ChIJN1t_tDeuEmsRUsoyG83frY4 ")).toBe(false)
	expect(isGooglePlaceID("valid\ninvalid")).toBe(false)
})

test("GOOGLE_PLACE_ID_PATTERN is the anchored character-class pattern", () => {
	expect(GOOGLE_PLACE_ID_PATTERN.source).toBe("^[A-Za-z0-9_-]+$")
	expect(GOOGLE_PLACE_ID_PATTERN.test("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(true)
	expect(GOOGLE_PLACE_ID_PATTERN.test("bad char")).toBe(false)
})
