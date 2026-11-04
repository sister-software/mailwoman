// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { GOOGLE_PLACE_ID_PATTERN, isGooglePlaceID } from "#index"

test("isGooglePlaceID accepts Google's documented example ID", () => {
	// Google's documented example ID for the Sydney Opera House.
	expect(isGooglePlaceID("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(true)
})

test("isGooglePlaceID rejects an empty string and any character outside [A-Za-z0-9_-], anchored end-to-end", () => {
	expect(isGooglePlaceID("")).toBe(false)
	expect(isGooglePlaceID("has space")).toBe(false)
	expect(isGooglePlaceID("equals=pad")).toBe(false)

	// A leading or trailing invalid character must fail even when the rest is valid —
	// proving the regex is anchored at both ends rather than merely "contains a valid run".
	expect(isGooglePlaceID(" ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(false)
	expect(isGooglePlaceID("ChIJN1t_tDeuEmsRUsoyG83frY4 ")).toBe(false)
})

test("GOOGLE_PLACE_ID_PATTERN behaves as the guard", () => {
	expect(GOOGLE_PLACE_ID_PATTERN.test("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe(true)
	expect(GOOGLE_PLACE_ID_PATTERN.test("bad char")).toBe(false)
})
