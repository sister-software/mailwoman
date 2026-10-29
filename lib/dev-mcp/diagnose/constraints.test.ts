import type { BIOLabel } from "@mailwoman/codex/component"
import { DECODE_TERMS, type DecodeSpanExplanation, type DecodeTermValues } from "@mailwoman/neural/decode-explanation"
import { describe, expect, it } from "vitest"

import { accountConstraints, renderReading, tallyConstraints } from "#dev-mcp/diagnose/constraints"

/* oxlint-disable sister-software/multiline-statement-padding -- recorded decodes keep setup beside their assertion */

const TEXT = "Unter den Linden 77, 10117 Berlin"

// shipped 10.7.0 (restaged fp32, de-de package), traced with postcodeRepair and localeHint DE.
const TOKENS: Array<[piece: string, start: number, end: number, label: BIOLabel]> = [
	["▁Unter", 0, 5, "B-street"],
	["▁", 6, 6, "O"],
	["den", 6, 9, "B-street"],
	["▁Linden", 10, 16, "I-street"],
	["▁7", 17, 18, "B-house_number"],
	["7", 18, 19, "I-house_number"],
	[",", 19, 20, "O"],
	["▁10", 21, 23, "B-postcode"],
	["1", 23, 24, "I-postcode"],
	["1", 24, 25, "I-postcode"],
	["7", 25, 26, "I-postcode"],
	["▁Berlin", 27, 33, "B-locality"],
]

const labels = TOKENS.map((token) => token[3])

const logitsOnly = (margin: number): DecodeTermValues =>
	({ ...Object.fromEntries(DECODE_TERMS.map((term) => [term, 0])), logits: margin }) as DecodeTermValues

/**
 * An explained span whose runner-up relabels one piece, as the recorded trace's spans do.
 */
function explained(
	pieceStart: number,
	pieceEnd: number,
	tag: string,
	margin: number,
	change: { piece: number; to: string }
): DecodeSpanExplanation {
	const runnerUp = labels
		.map((label, index) => (index === change.piece ? change.to : label))
		.slice(pieceStart, pieceEnd)

	return {
		pieceStart,
		pieceEnd,
		start: TOKENS[pieceStart]![1],
		end: TOKENS[pieceEnd - 1]![2],
		text: TEXT.slice(TOKENS[pieceStart]![1], TOKENS[pieceEnd - 1]![2]),
		tag,
		labels: labels.slice(pieceStart, pieceEnd),
		runnerUp: {
			labels: runnerUp,
			changes: [{ piece: change.piece, text: TOKENS[change.piece]![0], from: labels[change.piece]!, to: change.to }],
			total: 0,
		},
		margin,
		termMargins: logitsOnly(margin),
	}
}

const TRACE = {
	text: TEXT,
	pieces: TOKENS.map(([piece, start, end], index) => ({ piece, id: index, start, end })),
	tokens: TOKENS.map(([piece, start, end, label]) => ({ piece, start, end, label, confidence: 1 })),
	explanation: {
		decoderScore: 0,
		decodedTerms: logitsOnly(0),
		ledger: [],
		// The recorded margins, each a one-piece relabeling to B-country, all of it from the logits.
		spans: [
			explained(0, 1, "street", 5.16, { piece: 0, to: "B-country" }),
			explained(1, 2, "O", 3.74, { piece: 1, to: "B-country" }),
			explained(2, 4, "street", 5.15, { piece: 3, to: "B-country" }),
			explained(4, 6, "house_number", 4.9, { piece: 5, to: "B-country" }),
			explained(6, 7, "O", 3.82, { piece: 6, to: "B-country" }),
			explained(7, 11, "postcode", 4.91, { piece: 10, to: "B-country" }),
			explained(11, 12, "locality", 5.23, { piece: 11, to: "B-country" }),
		],
	},
}

const ROW = { id: "de-unter-den-linden", input: TEXT, country: "DE", expected: "street=unter den linden" }

describe("accountConstraints", () => {
	it("reports the street restart with both sides' margins and the closest runner-up", () => {
		const account = accountConstraints(ROW, "de-de", TRACE, { registry: [], streetAffix: [] })

		expect(account.violated).toEqual({ C4: true, C4_segment: true, C6: false })
		// The decode restarts the street and tree assembly joins it back, so the graded parse is right.
		expect(account.decoded).toBe("street=Unter ¦ den Linden | house_number=77 | postcode=10117 | locality=Berlin")
		expect(account.observed).toBe("street=Unter den Linden | house_number=77 | postcode=10117 | locality=Berlin")

		const [c4] = account.violations

		expect(c4).toEqual(
			expect.objectContaining({
				constraint: "C4",
				left: { tag: "street", text: "Unter" },
				right: { tag: "street", text: "den Linden" },
				closest_side: "right",
				dominant_term: "logits",
				runner_up: "street=Unter ¦ den | country=Linden | house_number=77 | postcode=10117 | locality=Berlin",
				repaired: false,
			})
		)
		expect(c4!.sides.right).toEqual(expect.objectContaining({ margin: 5.15, term_margins: { logits: 5.15 } }))
		expect(account.rendered).toContain('C4 @6 street="Unter" | street="den Linden"')
	})

	it("keeps C6 unread when no gazetteer FST was read", () => {
		const account = accountConstraints(ROW, "de-de", TRACE, { registry: null, streetAffix: [] })

		// The `Unter | den` boundary has no license among the sources read, so C4 is unread rather than clear.
		expect(account.violated).toEqual({ C4: null, C4_segment: null, C6: null })
		expect(tallyConstraints([account]).C6).toEqual(expect.objectContaining({ n_rows_read: 0, share: null }))
	})
})

describe("renderReading", () => {
	it("joins tuples of one tag in input order", () => {
		expect(renderReading(TEXT, TRACE.pieces, labels)).toContain("street=Unter ¦ den Linden")
	})
})
