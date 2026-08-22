/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The output pane's line list: section order, what each section reads from, and which sections disappear when their
 *   source has nothing to say.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { outputLines } from "mailwoman/debug-view/output-lines"
import type { GeocodeResult } from "mailwoman/geocode-core"
import type { GeocodeTrace } from "mailwoman/geocode-session"
import { describe, expect, it } from "vitest"

const TREE = {
	raw: "3215 SE Clinton St, Portland OR",
	roots: [
		{
			tag: "locality",
			value: "Portland",
			start: 20,
			end: 28,
			confidence: 0.97,
			children: [{ tag: "street", value: "SE Clinton St", start: 5, end: 18, confidence: 0.98, children: [] }],
		},
	],
} as AddressTree

const RESULT = {
	input: TREE.raw,
	lat: 45.50380788700005,
	lon: -122.6322,
	resolution_tier: "address_point",
	uncertainty_m: 1,
	countryCode: "US",
	components: {},
	locality: null,
	region: null,
	postcode: null,
	house_number: null,
	street: null,
	venue: null,
	dependent_locality: null,
	unit: null,
	postcode_country_scope: null,
	hierarchy: [
		{ tag: "locality", value: "Portland", name: "Portland", placeID: "wof:101715829", lat: 45.537178, lon: -122.65 },
	],
	candidates: [
		{ name: "Portland", tag: "locality", lat: 45.5, lon: -122.6, countryCode: "US", placeID: "wof:101715829" },
		{ name: "Portland", tag: "locality", lat: 43.66, lon: -70.25, countryCode: "US", placeID: "wof:101715745" },
	],
	intent_markers: [],
} as GeocodeResult

const TRACE = {
	kind: {
		kind: "structured_address",
		confidence: 0.9,
		alternatives: [{ kind: "vague", confidence: 0.3 }],
	},
} as unknown as GeocodeTrace

function labels(lines: ReturnType<typeof outputLines>): string[] {
	return lines.filter((line) => line.kind === "heading").map((line) => line.label)
}

describe("outputLines", () => {
	it("runs the demo's sections in the demo's order", () => {
		const lines = outputLines({ result: RESULT, tree: TREE, trace: TRACE, timing: { parse: 3.2, total: 9.5 } })

		expect(labels(lines)).toEqual(["components", "kind", "timing", "resolved", "hierarchy", "candidates"])
	})

	it("indents nested components and carries each node's own confidence", () => {
		const lines = outputLines({ result: RESULT, tree: TREE })
		const components = lines.slice(1, 3)

		expect(components[0]).toMatchObject({ label: "locality", value: "Portland", confidence: 0.97, tag: "locality" })
		expect(components[1]).toMatchObject({ label: "  street", value: "SE Clinton St", confidence: 0.98 })
	})

	it("omits the sections whose source produced nothing", () => {
		// No trace ⇒ no kind verdict and no timing to report. Omitted, not rendered empty: an empty `kind` section
		// would read as "the classifier had no opinion", which is a different claim from "nobody asked it".
		const lines = outputLines({ result: { ...RESULT, hierarchy: [], candidates: [] }, tree: TREE })

		expect(labels(lines)).toEqual(["components", "resolved"])
	})

	it("badges the tier and the kind, and colors an admin fallback differently", () => {
		const resolved = outputLines({ result: RESULT, tree: TREE, trace: TRACE }).find((line) => line.label === "  tier")

		expect(resolved).toMatchObject({ badge: "address_point", badgeColor: "green" })

		const admin = outputLines({ result: { ...RESULT, resolution_tier: "admin" }, tree: TREE }).find(
			(line) => line.label === "  tier"
		)

		expect(admin).toMatchObject({ badge: "admin", badgeColor: "yellow" })

		const kind = outputLines({ result: RESULT, tree: TREE, trace: TRACE }).find((line) => line.label === "  verdict")

		expect(kind).toMatchObject({ badge: "structured_address", confidence: 0.9 })
	})

	it("reads the resolved place off the DEEPEST hierarchy entry, not the candidate head", () => {
		// On a rooftop tier the candidate head is the resolver's primary NODE (often the region), which is not the
		// place the query resolved to. Regression for showing "Oregon" as the resolved place of a Portland address.
		const result = {
			...RESULT,
			candidates: [
				{ name: "Oregon", tag: "region", lat: 43.9, lon: -120.6, countryCode: "US", placeID: "wof:85688513" },
			],
		} as GeocodeResult

		const place = outputLines({ result, tree: TREE }).find((line) => line.label === "  place")

		expect(place).toMatchObject({ value: "Portland", detail: "wof:101715829 US" })
	})

	it("rounds coordinates to a readable precision", () => {
		const coordinate = outputLines({ result: RESULT, tree: TREE }).find((line) => line.label === "  coordinate")

		expect(coordinate?.value).toBe("45.503808, -122.6322")
	})

	it("lists the runner-up candidates only", () => {
		const lines = outputLines({ result: RESULT, tree: TREE })
		const candidates = lines.slice(lines.findIndex((line) => line.label === "candidates") + 1)

		expect(candidates).toHaveLength(1)
		expect(candidates[0]).toMatchObject({ value: "Portland", detail: "US 43.66, -70.25" })
	})

	it("puts a failed re-run's message first, as an error line", () => {
		const lines = outputLines({ result: RESULT, tree: TREE, errorNote: "resolver exploded" })

		expect(lines[0]).toEqual({ kind: "error", label: "resolver exploded" })
	})
})
