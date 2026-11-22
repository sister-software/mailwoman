// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The evidence rows' vocabulary against a hand-built trace.
 *
 *   The meaning-of-zero discipline distinguishes an unfed channel, a channel that
 *   fired on no token and a bundle with no locale head.
 */

import { describe, expect, it } from "vitest"

import {
	ABSENT,
	appliedRow,
	channelsRow,
	decodeRow,
	explanationRows,
	localeHeadRow,
	rewriteRows,
	rooftopRows,
	systemRow,
	tokensRow,
} from "#cli/debug-view/trace-rows"
import type { GeocodeApplied, GeocodeTrace } from "#geocode"

const TEXT = "3215 SE Clinton St"

/**
 * A whole query shape carrying only the formats a case wants to state, built rather than cast
 * so the annotated return type checks that a `format` name is one the detector can emit.
 */
function queryShapeOf(knownFormats: GeocodeTrace["queryShape"]["knownFormats"] = []): GeocodeTrace["queryShape"] {
	return {
		characterClass: "alphanumeric",
		scripts: [],
		tokenClasses: [],
		segments: [],
		knownFormats,
		regionAbbreviations: [],
		totalLength: TEXT.length,
	}
}

function traceOf(overrides: Partial<GeocodeTrace["parse"]> = {}): GeocodeTrace {
	return {
		parse: {
			text: TEXT,
			caseNormalized: false,
			pieces: [
				{ piece: "▁3", id: 1, start: 0, end: 4 },
				{ piece: "▁SE", id: 2, start: 5, end: 7 },
				{ piece: "▁Clinton", id: 3, start: 8, end: 15 },
			],
			logits: [],
			emissions: [],
			labels: [],
			path: [],
			decode: "viterbi",
			detectedSystem: "us",
			systemSource: "auto",
			priors: [
				{ kind: "queryShape", applied: true },
				{ kind: "fst", applied: false },
			],
			repairs: [],
			tokens: [
				{ piece: "▁3", start: 0, end: 4, label: "B-house_number", confidence: 0.9 },
				{ piece: "▁SE", start: 5, end: 7, label: "B-street_prefix", confidence: 0.8 },
				{ piece: "▁Clinton", start: 8, end: 15, label: "B-street", confidence: 1 },
			],
			...overrides,
		} as GeocodeTrace["parse"],
		queryShape: queryShapeOf(),
		kind: null,
		inputMode: "formatted",
		resolver: [],
		stages: [],
		stageTiming: {},
	}
}

function appliedOf(countryScope: GeocodeApplied["countryScope"]): GeocodeApplied {
	return { locale: { locale: "en-US", source: "default" }, countryScope }
}

describe("evidence rows without a trace", () => {
	it("every row reports its own absence rather than a plausible default", () => {
		for (const row of [systemRow, localeHeadRow, tokensRow, channelsRow, decodeRow]) {
			expect(row(null)).toBe(ABSENT)
		}
	})
})

describe("rewriteRows", () => {
	it("states each pass that changed the tree with the nodes it removed and added", () => {
		const trace = traceOf()

		trace.stages = [
			{
				kind: "tree-rewrite",
				stage: "region-recognition",
				removed: ['locality [0, 10): "Dublin, TX"'],
				added: ['region [8, 10): "TX" {"region_recognition":"us-state"}', '  locality [0, 6): "Dublin"'],
			},
			{ kind: "tree-rewrite", stage: "stranded-affix", removed: ['street_suffix [7, 11): "Park"'], added: [] },
		]

		expect(rewriteRows(trace.stages)).toEqual([
			{
				pass: "region-recognition",
				change:
					'locality [0, 10): "Dublin, TX" → region [8, 10): "TX" {"region_recognition":"us-state"} / locality [0, 6): "Dublin"',
			},
			{ pass: "stranded-affix", change: `street_suffix [7, 11): "Park" → ${ABSENT}` },
		])
	})

	it("is empty when every pass left the decoded tree as it was", () => {
		expect(rewriteRows(traceOf().stages)).toEqual([])
	})
})

describe("systemRow", () => {
	it("names the system, HOW it was chosen, the register and the detected formats", () => {
		expect(systemRow(traceOf())).toBe(`us (auto)  mode formatted  format ${ABSENT}`)
	})

	it("reports conventions-off as a source, not as a missing system", () => {
		const trace = traceOf({ detectedSystem: null, systemSource: "off" })

		expect(systemRow(trace)).toContain("none (off)")
	})

	it("lists the query-shape known formats when Stage 2 found any", () => {
		const trace = traceOf()

		trace.queryShape = queryShapeOf([{ format: "us_zip", span: { start: 0, end: 5, body: "97202" }, confidence: 1 }])

		expect(systemRow(trace)).toContain("format us_zip")
	})
})

describe("appliedRow", () => {
	it("states the locale and the scope with the source of each, and the scope's strength", () => {
		const applied = appliedOf({ resolver: { country: "US", source: "inferred", strength: "hard" }, withheld: null })

		expect(appliedRow(applied)).toBe("locale en-US (default)  scope US hard (inferred)")
	})

	it("tells a scope that was turned off from one the session withheld, and gives the reason", () => {
		expect(appliedRow(appliedOf({ resolver: null, withheld: null }))).toBe("locale en-US (default)  scope none")

		expect(appliedRow(appliedOf({ resolver: null, withheld: { country: "US", reason: "bare_locality" } }))).toBe(
			"locale en-US (default)  scope none  withheld US (bare_locality)"
		)
	})

	it("says the geocode didn't resolve rather than printing a scope the resolver never received", () => {
		expect(appliedRow(appliedOf(null))).toBe(`locale en-US (default)  scope ${ABSENT} not resolved`)
		expect(appliedRow(null)).toBe(ABSENT)
	})
})

describe("localeHeadRow", () => {
	it("softmaxes the head onto its OWN axis, highest first", () => {
		const trace = traceOf({ localeLogits: [4, 1, 0], localeCountries: ["US", "FR", "DE"] })
		const row = localeHeadRow(trace)

		expect(row.startsWith("US 0.9")).toBe(true)
		expect(row).toContain("FR 0.0")
		// The axis is read off the trace, so a re-ordered head must re-order the row rather than be re-labeled here.
		expect(localeHeadRow(traceOf({ localeLogits: [1, 4, 0], localeCountries: ["US", "FR", "DE"] }))).toMatch(/^FR /u)
	})

	it("says the bundle has no head instead of printing zeros", () => {
		expect(localeHeadRow(traceOf())).toContain("no locale head")
	})
})

describe("tokensRow", () => {
	it("leads with the count and keeps the word-start sentinel", () => {
		expect(tokensRow(traceOf())).toBe("3  ▁3 ▁SE ▁Clinton")
	})
})

describe("channelsRow", () => {
	it("distinguishes a channel that was never fed from one that matched nothing", () => {
		const trace = traceOf({
			anchor: { features: [[], [], []], confidence: [0, 0, 0] },
			gazetteer: { features: [[], [], []], confidence: [0, 0, 1] },
		})

		const row = channelsRow(trace)

		expect(row).toContain("anchor 0/3")
		expect(row).toContain("gazetteer 1/3 [Clinton]")
		expect(row).toContain("country not fed")
	})

	it("reports the two evidence channels, the input mode and a pin beside the three admin channels", () => {
		const trace = traceOf({
			streetType: { features: [[0], [0], [1]], confidence: [0, 0, 1] },
			localitySurface: {
				features: [
					[0, 0],
					[0, 0],
					[0, 0],
				],
				confidence: [0, 0, 0],
			},
			inputMode: "fragmented",
			channelPins: { locality_surface: "off" },
		})

		const row = channelsRow(trace)

		expect(row).toContain("street_type 1/3 [Clinton]")
		expect(row).toContain("locality_surface 0/3 (pinned off)")
		expect(row).toContain("mode fragmented")
	})

	it("reads a withheld evidence channel as not fed and says which register withheld it", () => {
		const row = channelsRow(traceOf({ inputMode: "formatted" }))

		expect(row).toContain("street_type not fed")
		expect(row).toContain("locality_surface not fed")
		expect(row).toContain("mode formatted")
	})
})

describe("decodeRow", () => {
	it("names the algorithm, the mean confidence, the component run, the priors that FIRED and the repairs", () => {
		expect(decodeRow(traceOf())).toBe(
			`viterbi  conf 0.90  house_number street_prefix street  priors queryShape  repairs ${ABSENT}`
		)
	})

	it("reports a repair pass that changed labels", () => {
		const trace = traceOf({
			repairs: [{ pass: "wordConsistency", before: ["B-street"], after: ["B-locality"] }],
		})

		expect(decodeRow(trace)).toContain("repairs wordConsistency")
	})

	it("adds the passes that rewrote the tree, and only when one did", () => {
		const trace = traceOf()

		trace.stages = [
			{ kind: "country-scope", stage: "country-scope", resolver: null, withheld: null },
			{ kind: "tree-rewrite", stage: "region-recognition", removed: ['region [9, 11): "KS"'], added: [] },
		]

		expect(decodeRow(trace)).toBe(
			`viterbi  conf 0.90  house_number street_prefix street  rewrites region-recognition  priors queryShape  repairs ${ABSENT}`
		)
	})
})

describe("rooftopRows", () => {
	it("states the source of each resolve and what the second one changed", () => {
		const trace = traceOf()

		trace.stages = [
			{
				kind: "rooftop-selection",
				stage: "rooftop-selection",
				first: { country: "gb", source: "national" },
				second: { country: "IE", source: "osm", changed: ["address-points", "placetype-map"] },
			},
			{ kind: "rooftop-selection", stage: "rooftop-selection", first: { country: null, source: null }, second: null },
		]

		expect(rooftopRows(trace.stages)).toEqual([
			"national for gb  second resolve for IE: osm, changed address-points,placetype-map",
			`${ABSENT} for ${ABSENT}`,
		])
	})
})

describe("explanationRows", () => {
	const zeroTerms = {
		logits: 0,
		queryShape: 0,
		fst: 0,
		streetMorphology: 0,
		spanProposer: 0,
		venueHead: 0,
		placetypePair: 0,
		placetypePairTransitions: 0,
		conventionsMask: 0,
		transitions: 0,
	}

	it("reports its absence when the trace carries no explanation", () => {
		expect(explanationRows(traceOf({ explanation: null }))).toEqual([
			`runner-up: ${ABSENT} no decode explanation in this trace`,
		])
	})

	it("names each span's runner-up with its nonzero term margins and each prior's ledger entry", () => {
		const trace = traceOf({
			explanation: {
				decoderScore: 4,
				decodedTerms: { ...zeroTerms, logits: 3, fst: 1 },
				spans: [
					{
						pieceStart: 2,
						pieceEnd: 3,
						start: 8,
						end: 15,
						text: "Clinton",
						tag: "street",
						labels: ["B-street"],
						runnerUp: {
							labels: ["B-locality"],
							changes: [{ piece: 2, text: "▁Clinton", from: "B-street", to: "B-locality" }],
							total: 2.5,
						},
						margin: 1.5,
						termMargins: { ...zeroTerms, logits: -0.5, fst: 2 },
					},
				],
				ledger: [
					{
						prior: "fst",
						cells: [{ piece: 2, label: "B-street", delta: 1 }],
						transitionBonuses: [],
						decodedPathContribution: 1,
						changes: [{ piece: 2, text: "▁Clinton", from: "B-street", to: "B-locality" }],
						changedSpans: [0],
						totalWithout: 3.2,
					},
				],
			},
		})

		expect(explanationRows(trace)).toEqual([
			'runner-up street "Clinton": [Clinton B-street→B-locality] margin 1.50 = fst +2.00, logits -0.50',
			"ledger fst: +1.00 on the decoded reading, 1 cells; without it: Clinton B-street→B-locality",
		])
	})
})
