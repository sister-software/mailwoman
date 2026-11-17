// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import {
	type GeocodeOutcomeInput,
	geocodeRequirementSelects,
	scoreGeocodeOutcome,
} from "#tools/eval-harness/heldout/per/geocode-outcome"

/**
 * A held-out row from spans given as `[tag, text]`, joined by `, `.
 */
function row(country: string, spans: Array<[string, string]>, source = "usgov-nad"): HeldoutRow {
	let raw = ""
	const starts: number[] = []
	const ends: number[] = []

	for (const [i, [, text]] of spans.entries()) {
		if (i) {
			raw += ", "
		}

		starts.push(raw.length)
		raw += text
		ends.push(raw.length)
	}

	return {
		raw,
		span_starts: starts,
		span_ends: ends,
		span_tags: spans.map(([tag]) => tag),
		country,
		source,
		source_id: "r1",
		group: "r1",
	}
}

const place = (tag: string, value: string) => ({
	tag,
	value,
	name: value,
	lat: null,
	lon: null,
	placeID: null,
	in_winner_lineage: null,
})

// The county-fallback row lane Y measured, under the relabeled answer key.
const carter = row("US", [
	["house_number", "2368"],
	["street", "foxden"],
	["street_suffix", "road"],
	["subregion", "carter county"],
	["region", "ok"],
	["postcode", "73401"],
])

const off: GeocodeOutcomeInput = {
	components: {
		house_number: "2368",
		street: "foxden",
		street_suffix: "road",
		locality: "carter county",
		region: "ok",
		postcode: "73401",
	},
	dropped_components: null,
	hierarchy: [place("region", "ok"), place("country", "")],
}

const on: GeocodeOutcomeInput = {
	...off,
	components: {
		house_number: "2368",
		street: "foxden",
		street_suffix: "road",
		subregion: "Carter County",
		region: "ok",
		postcode: "73401",
	},
	hierarchy: [place("subregion", "carter county"), place("region", "OK")],
}

describe("scoreGeocodeOutcome", () => {
	it("grades the resolver's county retag against an answer key that writes the county as subregion", () => {
		expect(scoreGeocodeOutcome(carter, off)).toMatchObject({
			exact: false,
			missing: ["subregion=carter county"],
			additional: ["locality=carter county"],
			unplaced: ["subregion=carter county"],
		})

		expect(scoreGeocodeOutcome(carter, on)).toEqual({
			exact: true,
			componentsExact: true,
			placesExact: true,
			missing: [],
			additional: [],
			unplaced: [],
		})
	})

	it("refuses a component that is right when its place is not resolved at that tag", () => {
		const unresolved = { ...on, hierarchy: [place("region", "ok")] }

		expect(scoreGeocodeOutcome(carter, unresolved)).toMatchObject({
			exact: false,
			componentsExact: true,
			placesExact: false,
			unplaced: ["subregion=carter county"],
		})
	})

	it("joins the street family into one bag of words under the whole convention", () => {
		const de = row("DE", [
			["street", "Lister"],
			["street_suffix", "Straße"],
			["house_number", "4"],
			["locality", "Hannover"],
		])

		const joined = {
			components: { street: "Lister Straße", house_number: "4", locality: "Hannover" },
			dropped_components: null,
			hierarchy: [place("locality", "Hannover")],
		}

		expect(scoreGeocodeOutcome(de, joined).exact).toBe(true)
	})

	it("counts a dropped duplicate span as returned", () => {
		const twice = row("US", [
			["locality", "Springfield"],
			["locality", "Shelbyville"],
		])

		const result = {
			components: { locality: "Springfield" },
			dropped_components: [{ tag: "locality" as const, value: "Shelbyville", kept: "Springfield" }],
			hierarchy: [place("locality", "Springfield"), place("locality", "Shelbyville")],
		}

		expect(scoreGeocodeOutcome(twice, result).exact).toBe(true)
	})
})

describe("geocodeRequirementSelects", () => {
	const req = { countries: ["US"], select: { kinds: ["address" as const], withoutTags: ["venue"] } }

	it("reads an address row of a listed country and leaves out probes, gazetteer rows and excluded tags", () => {
		const probes = new Set(["invented-po-box-cedex"])

		expect(geocodeRequirementSelects(req, carter, probes)).toBe(true)
		expect(geocodeRequirementSelects(req, { ...carter, country: "FR" }, probes)).toBe(false)
		expect(geocodeRequirementSelects(req, { ...carter, source: "invented-po-box-cedex" }, probes)).toBe(false)
		expect(geocodeRequirementSelects(req, { ...carter, source: "wof-admin" }, probes)).toBe(false)
		expect(geocodeRequirementSelects(req, { ...carter, span_tags: ["venue"] }, probes)).toBe(false)
	})
})
