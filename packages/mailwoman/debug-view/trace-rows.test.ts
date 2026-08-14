/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The evidence rows' vocabulary, against a hand-built trace. What these tests are really guarding is the
 *   meaning-of-zero discipline: an unfed channel, a channel that fired on nothing, and a bundle with no locale head
 *   are three different statements, and a row that collapsed any pair of them would make its own question
 *   unanswerable.
 */

import { describe, expect, it } from "vitest"

import type { GeocodeTrace } from "../geocode-session.ts"
import { ABSENT, channelsRow, decodeRow, localeHeadRow, systemRow, tokensRow } from "./trace-rows.ts"

function traceOf(overrides: Partial<GeocodeTrace["parse"]> = {}): GeocodeTrace {
	return {
		parse: {
			text: "3215 SE Clinton St",
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
		queryShape: { knownFormats: [] } as unknown as GeocodeTrace["queryShape"],
		inputMode: "formatted",
		locale: "en-US",
	}
}

describe("evidence rows without a trace", () => {
	it("every row reports its own absence rather than a plausible default", () => {
		for (const row of [systemRow, localeHeadRow, tokensRow, channelsRow, decodeRow]) {
			expect(row(undefined)).toBe(ABSENT)
		}
	})
})

describe("systemRow", () => {
	it("names the system, HOW it was chosen, the register, the locale and the detected formats", () => {
		expect(systemRow(traceOf())).toBe(`us (auto)  mode formatted  locale en-US  format ${ABSENT}`)
	})

	it("reports conventions-off as a source, not as a missing system", () => {
		const trace = traceOf({ detectedSystem: null, systemSource: "off" })

		expect(systemRow(trace)).toContain("none (off)")
	})

	it("lists the query-shape known formats when Stage 2 found any", () => {
		const trace = traceOf()

		trace.queryShape = {
			knownFormats: [{ format: "us_zip5", span: { start: 0, end: 5 }, confidence: 1 }],
		} as unknown as GeocodeTrace["queryShape"]

		expect(systemRow(trace)).toContain("format us_zip5")
	})
})

describe("localeHeadRow", () => {
	it("softmaxes the head onto its OWN axis, highest first", () => {
		const trace = traceOf({ localeLogits: [4, 1, 0], localeCountries: ["US", "FR", "DE"] })
		const row = localeHeadRow(trace)

		expect(row.startsWith("US 0.9")).toBe(true)
		expect(row).toContain("FR 0.0")
		// The axis is read off the trace — a re-ordered head must re-order the row, never be re-labelled by us.
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
})
