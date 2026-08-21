/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The span diff, which is where a parse comparison can lie quietly.
 *
 *   Both parsers speak libpostal's label vocabulary, and mailwoman's route into it is many-to-one. So the two ways this
 *   can mislead are opposite: reporting a disagreement that is really a case or segmentation difference, and reporting
 *   an agreement that is really two different tags landing on one label.
 */

import { diffSpans, SpanVerdict, type LabelledSpan } from "@mailwoman/dev-mcp/parse-compare"
import { describe, expect, it } from "vitest"

function span(label: string, value: string, tag?: string): LabelledSpan {
	return tag === undefined ? { label, value } : { label, value, tag }
}

describe("diffSpans", () => {
	it("folds case, since libpostal lowercases and mailwoman does not", () => {
		const [diff] = diffSpans([span("city", "Bristol", "locality")], [span("city", "bristol")])

		expect(diff).toMatchObject({ verdict: SpanVerdict.Agree })
	})

	it("joins repeated labels before comparing", () => {
		// libpostal emits one span per occurrence; mailwoman's collapse can emit a different number for the same
		// reading. Comparing occurrence-by-occurrence reports a segmentation difference as a parse disagreement.
		const [diff] = diffSpans(
			[span("road", "Main St", "intersection_a"), span("road", "5th Ave", "intersection_b")],
			[span("road", "main st 5th ave")]
		)

		expect(diff).toMatchObject({ verdict: SpanVerdict.Agree, mailwoman: "Main St 5th Ave" })
	})

	it("marks a label several mailwoman tags collapse onto", () => {
		// `road` carries street, intersection_a and intersection_b, so agreeing on it is not agreeing on what was
		// asserted. Without the marker a reader takes the label at face value.
		const [diff] = diffSpans([span("road", "Main St", "street")], [span("road", "main st")])

		expect(diff?.collapsed_from).toContain("intersection_a")
		expect(diff?.collapsed_from).toContain("street")
	})

	it("leaves a one-to-one label unmarked", () => {
		const [diff] = diffSpans([span("postcode", "EC3A 8BN", "postcode")], [span("postcode", "ec3a 8bn")])

		expect(diff).not.toHaveProperty("collapsed_from")
	})

	it("names which side produced a label the other did not", () => {
		const diff = diffSpans([span("suburb", "St Mary Axe", "dependent_locality")], [span("house", "st andrew church")])

		expect(diff.find((entry) => entry.label === "suburb")).toMatchObject({
			verdict: SpanVerdict.MailwomanOnly,
			libpostal: null,
		})

		expect(diff.find((entry) => entry.label === "house")).toMatchObject({
			verdict: SpanVerdict.LibpostalOnly,
			mailwoman: null,
		})
	})

	it("reports a real value disagreement as one", () => {
		const [diff] = diffSpans([span("road", "St Andrew Undershaft Church", "street")], [span("road", "st mary axe")])

		expect(diff).toMatchObject({
			verdict: SpanVerdict.ValueDiffers,
			mailwoman: "St Andrew Undershaft Church",
			libpostal: "st mary axe",
		})
	})
})
