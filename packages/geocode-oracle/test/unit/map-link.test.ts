/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `parseMapURL` — reading a place PIN out of an expanded Google Maps URL.
 *
 *   The URLs below are real, captured from the 2026-08-23 authoring batch, because the whole risk here is reading the
 *   wrong one of two coordinate pairs and a hand-written fixture would not carry both.
 */

import { parseMapURL } from "@mailwoman/geocode-oracle/sdk/map-link"
import { describe, expect, it } from "vitest"

/**
 * Real, from the batch. Carries BOTH an `@` viewport and a `!3d`/`!4d` pin, which is the point.
 */
const DONKEYS =
	"https://www.google.com/maps/place/Donkey's+Place+Downtown/@39.9942189,-74.792132,1062m/data=!3m1!1e3!4m6!3m5!1s0x89c149851392e0e1:0x5fa9b478e2137c3b!8m2!3d39.9933298!4d-74.7902421!16s%2Fg%2F11p0564gth"

describe("parseMapURL", () => {
	it("takes the PLACE PIN, not the viewport, when both are present", () => {
		// The two differ by ~230 m here. Reading `@` instead would spend the entire tolerance budget of a rooftop case
		// before the geocoder is even asked anything.
		const row = parseMapURL("https://maps.app.goo.gl/Ze46", DONKEYS)

		expect(row.resolved).toBe(true)
		expect(row.source).toBe("place-pin")
		expect(row.latitude).toBe(39.9933298)
		expect(row.longitude).toBe(-74.7902421)
	})

	it("reads the place name Google put in the path, so a link to the WRONG place is visible", () => {
		// A coordinate alone cannot show that a link points somewhere other than the caller believed.
		expect(parseMapURL("https://maps.app.goo.gl/Ze46", DONKEYS).name).toBe("Donkey's Place Downtown")
	})

	it("falls back to the viewport ONLY when there is no pin, and says so", () => {
		const row = parseMapURL("u", "https://www.google.com/maps/place/Somewhere/@51.5074,-0.1278,15z/data=!3m1!1e3")

		expect(row.source).toBe("viewport-centre")
		expect(row.latitude).toBe(51.5074)
		// A labelled fallback, never a silent one — the reason travels with the row.
		expect(row.reason).toMatch(/CAMERA/)
	})

	it("keeps a NEGATIVE longitude and latitude intact", () => {
		// A dropped minus sign is the classic coordinate defect and it lands the row on the other side of the planet.
		const row = parseMapURL("u", "https://www.google.com/maps/place/X/@-33.3,18.2,15z/data=!3d-33.3691538!4d18.2602319")

		expect(row.latitude).toBe(-33.3691538)
		expect(row.longitude).toBe(18.2602319)
	})

	it("reports an unresolvable URL rather than inventing a coordinate", () => {
		// Never 0,0 and never a silent drop: a batch that loses rows quietly produces a case file whose denominator
		// nobody can reconstruct.
		const row = parseMapURL("https://maps.app.goo.gl/nope", "https://www.google.com/maps/search/nothing+here")

		expect(row.resolved).toBe(false)
		expect(row.latitude).toBeUndefined()
		expect(row.reason).toMatch(/neither/)
	})

	it("carries the expanded URL so the parse can be audited without re-fetching", () => {
		expect(parseMapURL("https://maps.app.goo.gl/Ze46", DONKEYS).expandedURL).toBe(DONKEYS)
	})
})
