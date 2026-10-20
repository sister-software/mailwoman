import { describe, expect, it } from "vitest"

import { scoreExactParse, validateAnnotatedSpans } from "#tools/eval-harness/score/exact-parse"

// The annotated street span [3, 11) ends on the space before the comma, so trimming moves its end to 10.
const raw = "12 Main St ,Springfield"

const gold = validateAnnotatedSpans(
	{
		raw,
		span_starts: [0, 3, 12],
		span_ends: [2, 11, 23],
		span_tags: ["house_number", "street", "locality"],
	},
	"row-1"
)

describe("scoreExactParse", () => {
	it("accepts identical spans, trimming edge whitespace", () => {
		expect(gold[1]).toEqual({ tag: "street", start: 3, end: 10 })

		expect(
			scoreExactParse(raw, gold, [
				{ tag: "house_number", start: 0, end: 3 },
				{ tag: "street", start: 3, end: 10 },
				{ tag: "locality", start: 12, end: 23 },
			]).exact
		).toBe(true)
	})

	it("refuses an extra predicted span", () => {
		const outcome = scoreExactParse(raw, gold, [...gold, { tag: "region", start: 12, end: 23 }])

		expect(outcome).toMatchObject({
			exact: false,
			missing: [],
			additional: [{ tag: "region" }],
		})
	})

	it("refuses a missing span", () => {
		expect(scoreExactParse(raw, gold, gold.slice(0, 2))).toMatchObject({
			exact: false,
			missing: [{ tag: "locality" }],
			additional: [],
		})
	})

	it("refuses a boundary shift", () => {
		const outcome = scoreExactParse(raw, gold, [gold[0]!, { tag: "street", start: 3, end: 7 }, gold[2]!])

		expect(outcome.exact).toBe(false)
		expect(outcome.missing).toEqual([{ tag: "street", start: 3, end: 10 }])
		expect(outcome.additional).toEqual([{ tag: "street", start: 3, end: 7 }])
	})

	it("matches repeated components as a multiset", () => {
		const twice = "Springfield, Springfield"

		const spans = validateAnnotatedSpans(
			{
				raw: twice,
				span_starts: [0, 13],
				span_ends: [11, 24],
				span_tags: ["locality", "locality"],
			},
			"row-2"
		)

		expect(scoreExactParse(twice, spans, spans).exact).toBe(true)

		expect(scoreExactParse(twice, spans, [spans[0]!, spans[0]!])).toMatchObject({
			exact: false,
			missing: [{ start: 13 }],
			additional: [{ start: 0 }],
		})
	})
})

describe("validateAnnotatedSpans", () => {
	const refuse = (row: Parameters<typeof validateAnnotatedSpans>[0]) => () => validateAnnotatedSpans(row, "src:42")

	it("refuses malformed annotations with the row identity", () => {
		expect(
			refuse({
				raw,
				span_starts: [0],
				span_ends: [2, 3],
				span_tags: ["street"],
			})
		).toThrow(/row src:42/u)

		expect(refuse({ raw, span_starts: [0], span_ends: [99], span_tags: ["street"] })).toThrow(/outside/u)
		expect(refuse({ raw, span_starts: [2], span_ends: [3], span_tags: ["street"] })).toThrow(/whitespace/u)

		expect(
			refuse({
				raw,
				span_starts: [0],
				span_ends: [2],
				span_tags: ["street_name"],
			})
		).toThrow(/unknown tag/u)

		expect(
			refuse({
				raw,
				span_starts: [0, 1],
				span_ends: [5, 8],
				span_tags: ["house_number", "street"],
			})
		).toThrow(/overlaps/u)
	})
})
