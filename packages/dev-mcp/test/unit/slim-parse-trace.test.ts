/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The slim-trace pin: the matrices go, every discrete diagnostic stays, and the omission announces itself. The full
 *   payload measured in the thousands of floats per input and crowded the very context windows the trace exists to
 *   inform — the numbers nobody reads inline cost more than they said.
 */

import { slimParseTrace } from "@mailwoman/dev-mcp/tool-kit"
import { describe, expect, it } from "vitest"

const PARSE = {
	text: "KT2 6AB",
	pieces: [{ piece: "▁K", id: 1, start: 0, end: 1 }],
	tokens: [{ piece: "▁K", start: 0, end: 1, label: "B-postcode", confidence: 0.91 }],
	path: [9],
	decode: "viterbi",
	repairs: [],
	labels: ["O", "B-postcode"],
	priors: [{ kind: "queryShape", applied: true }],
	localeLogits: [1.5, -0.2],
	localeCountries: ["US", "FR"],
	logits: [[0.1, 0.2]],
	emissions: [[0.3, 0.4]],
	anchor: { features: [[0, 0]], confidence: [0.5] },
	gazetteer: { features: [[1, 0]], confidence: [1] },
	country: { features: [[0, 1]], confidence: [0] },
} as never

describe("slimParseTrace", () => {
	it("drops the matrices, keeps the discrete diagnostics, and says what it omitted", () => {
		const slim = slimParseTrace(PARSE) as Record<string, unknown>

		expect(slim["logits"]).toBeUndefined()
		expect(slim["emissions"]).toBeUndefined()
		expect(slim["anchor"]).toEqual({ confidence: [0.5] })
		expect(slim["gazetteer"]).toEqual({ confidence: [1] })
		expect(slim["country"]).toEqual({ confidence: [0] })

		expect(slim["tokens"]).toEqual(PARSE["tokens" as never])
		expect(slim["path"]).toEqual([9])
		expect(slim["localeLogits"]).toEqual([1.5, -0.2])
		expect(String(slim["matrices_omitted"])).toContain("full_parse_trace")
	})
})
