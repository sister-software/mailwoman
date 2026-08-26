/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The punctuation law's two guards, its three exclusion rules, and the failure line a violation produces.
 *
 *   The load-bearing pair is `punctuationBlindKey` and `punctuationApplicability`. The key refuses a pair that
 *   changed anything besides punctuation; the rules refuse a pair the key ACCEPTS but whose mark the
 *   transformation may not take — because the query holds none, because the mark is part of a name, or
 *   because the row's comparator would read the transformation back out of a component value and report it as
 *   a pipeline defect.
 *
 *   INDEPENDENCE IS ASSERTED IN BOTH DIRECTIONS, and that is what makes a seeded punctuation regression
 *   attributable. A case, spacing or Unicode-normalization change is refused by this law's own audit, and a
 *   punctuation-only pair is refused by the case-folding and spacing classifiers — so a failing arm here
 *   cannot be a mis-filed row from either of the other two suites, and neither of them can absorb this one.
 *
 *   Every exclusion is exercised against a real committed board row rather than an invented string: the venue
 *   whose own name carries a point, the bare GB unit code that carries no punctuation at all, and the two
 *   rows whose asserted span carries the abbreviation point their comparator would grade.
 */

import { classifyCaseTransformation } from "mailwoman/eval-harness/conformance/case-folding"
import type { ConformanceOutcome } from "mailwoman/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditPunctuationSuite,
	classifyPunctuationTransformation,
	describePunctuationTransformation,
	PUNCTUATION_APPLICABILITY_RULES,
	PUNCTUATION_LAW,
	PUNCTUATION_TRANSFORMATION_BY_NAME,
	PUNCTUATION_TRANSFORMATION_SCOPE,
	PUNCTUATION_TRANSFORMATIONS,
	punctuationApplicability,
	punctuationBlindKey,
} from "mailwoman/eval-harness/conformance/punctuation"
import {
	type ConformanceObserver,
	formatConformanceFinding,
	runConformanceFixtures,
} from "mailwoman/eval-harness/conformance/run"
import { classifyWhitespaceTransformation } from "mailwoman/eval-harness/conformance/whitespace"
import { describe, expect, it } from "vitest"

/**
 * Committed board inputs, verbatim. Quoted here rather than loaded so a test failure shows the exact text under
 * discussion; `punctuation-suite.test.ts` is what proves the suite's own rows still match the corpus.
 */
const GB_LLOYDS = "Lloyd's of London, 1 Lime St, London EC3M 7HA"
const GD_ST_GEORGES = "St. George's"
const GB_KINGS_ROAD = "King’s Road"
const GB_BARE_POSTCODE = "N7 0BT"
const FR_COMER = "COMER parís.méxico"
const DE_NIPPES = "Neusser Str. 12, Nippes, 50733 Köln"
const US_MLK = "Martin Luther King Jr. Boulevard"

function fixture(over: Partial<ConformanceFixture> = {}): ConformanceFixture {
	return {
		id: "pn-sample-comma-removed",
		law: PUNCTUATION_LAW,
		base: DE_NIPPES,
		variant: PUNCTUATION_TRANSFORMATION_BY_NAME["comma-removed"](DE_NIPPES),
		context: { caseCountry: "DE" },
		outcomeComparator: "component_map",
		expect: "equivalent",
		rowRef: "cases/de/regression.jsonl#de-r9-nippes-koeln",
		...over,
	}
}

describe("punctuation transformations", () => {
	it("closes the set at five, and gives each one a scope", () => {
		expect([...PUNCTUATION_TRANSFORMATIONS]).toEqual([
			"comma-removed",
			"period-removed",
			"terminal-period",
			"apostrophe-typographic",
			"apostrophe-ascii",
		])

		for (const transformation of PUNCTUATION_TRANSFORMATIONS) {
			expect(PUNCTUATION_TRANSFORMATION_SCOPE[transformation]).toBeTruthy()
		}
	})

	it("renders the registers of one committed query", () => {
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["comma-removed"](GB_LLOYDS)).toBe(
			"Lloyd's of London 1 Lime St London EC3M 7HA"
		)

		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["terminal-period"](GB_LLOYDS)).toBe(
			"Lloyd's of London, 1 Lime St, London EC3M 7HA."
		)

		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["apostrophe-typographic"](GB_LLOYDS)).toBe(
			"Lloyd’s of London, 1 Lime St, London EC3M 7HA"
		)
	})

	it("drops an abbreviation point and leaves the spacing exactly as it found it", () => {
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["period-removed"](DE_NIPPES)).toBe("Neusser Str 12, Nippes, 50733 Köln")
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["period-removed"](GD_ST_GEORGES)).toBe("St George's")
	})

	it("leaves a mark that sits inside a token alone", () => {
		// The point in the venue's own name, and the ellipsis a name ends on — neither is a separator.
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["period-removed"](FR_COMER)).toBe(FR_COMER)

		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["period-removed"]("and more..., 1217 Queen St")).toBe(
			"and more..., 1217 Queen St"
		)

		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["comma-removed"]("Letter West,Derrynagree, Co. Kerry")).toBe(
			"Letter West,Derrynagree Co. Kerry"
		)
	})

	it("turns the apostrophe both ways, and each direction is a no-op on the other form", () => {
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["apostrophe-ascii"](GB_KINGS_ROAD)).toBe("King's Road")
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["apostrophe-typographic"](GB_KINGS_ROAD)).toBe(GB_KINGS_ROAD)
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["apostrophe-ascii"](GB_LLOYDS)).toBe(GB_LLOYDS)
	})

	it("appends a full stop once — a query already ending in one is left alone", () => {
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["terminal-period"](GB_BARE_POSTCODE)).toBe("N7 0BT.")
		expect(PUNCTUATION_TRANSFORMATION_BY_NAME["terminal-period"]("N7 0BT.")).toBe("N7 0BT.")
	})

	it("leaves case, spacing and every other codepoint exactly as it found them", () => {
		for (const transformation of PUNCTUATION_TRANSFORMATIONS) {
			const variant = PUNCTUATION_TRANSFORMATION_BY_NAME[transformation](DE_NIPPES)

			expect(punctuationBlindKey(variant), transformation).toBe(punctuationBlindKey(DE_NIPPES))
		}
	})
})

describe("punctuationBlindKey", () => {
	it("matches a query against every one of its own punctuation variants", () => {
		expect(punctuationBlindKey("Lloyds of London 1 Lime St London EC3M 7HA.")).toBe(punctuationBlindKey(GB_LLOYDS))
	})

	it.each([
		["case", GB_LLOYDS, GB_LLOYDS.toUpperCase()],
		["spacing", GB_LLOYDS, GB_LLOYDS.replace(", 1 Lime", ",  1 Lime")],
		["normalization", "Avenue de l’Opéra", "Avenue de l’Opéra".normalize("NFD")],
		["transliteration", "Köln", "Koeln"],
	])("separates a %s change from a punctuation change", (_label, base, changed) => {
		expect(punctuationBlindKey(base)).not.toBe(punctuationBlindKey(changed))
	})

	it("matches a hyphen-for-dash swap too — the key is what lets the CLASSIFIER refuse it by name", () => {
		expect(punctuationBlindKey("Bonneuil–sur–Marne")).toBe(punctuationBlindKey("Bonneuil-sur-Marne"))
		expect(classifyPunctuationTransformation("Bonneuil-sur-Marne", "Bonneuil–sur–Marne")).toBeNull()
	})
})

describe("classifyPunctuationTransformation", () => {
	it.each([
		["comma-removed", GB_LLOYDS],
		["period-removed", DE_NIPPES],
		["terminal-period", GB_BARE_POSTCODE],
		["apostrophe-typographic", GB_LLOYDS],
		["apostrophe-ascii", GB_KINGS_ROAD],
	] as const)("names %s from the pair alone", (transformation, base) => {
		const variant = PUNCTUATION_TRANSFORMATION_BY_NAME[transformation](base)

		expect(classifyPunctuationTransformation(base, variant)).toBe(transformation)
	})

	it("refuses an identical pair — that is the identity law, not a punctuation one", () => {
		expect(classifyPunctuationTransformation(GB_LLOYDS, GB_LLOYDS)).toBeNull()
	})

	it("refuses a pair that changed more than punctuation", () => {
		expect(classifyPunctuationTransformation("Portland, OR", "portland OR")).toBeNull()
	})

	it("refuses a punctuation permutation no named transformation produces", () => {
		expect(punctuationBlindKey(GB_LLOYDS)).toBe(punctuationBlindKey("Lloyd's of London; 1 Lime St, London EC3M 7HA"))
		expect(classifyPunctuationTransformation(GB_LLOYDS, "Lloyd's of London; 1 Lime St, London EC3M 7HA")).toBeNull()
	})
})

describe("independence from the case-folding and spacing laws", () => {
	it("refuses, in this law, a variant that only changed case or spacing", () => {
		expect(auditPunctuationSuite([fixture({ variant: DE_NIPPES.toUpperCase() })])[0]).toContain(
			"differs by more than punctuation"
		)

		expect(auditPunctuationSuite([fixture({ variant: DE_NIPPES.replace(", Nippes", ",  Nippes") })])[0]).toContain(
			"differs by more than punctuation"
		)

		expect(auditPunctuationSuite([fixture({ variant: DE_NIPPES.normalize("NFD") })])[0]).toContain(
			"differs by more than punctuation"
		)
	})

	it("is refused, by the other two laws, for every punctuation transformation it states", () => {
		for (const transformation of PUNCTUATION_TRANSFORMATIONS) {
			const variant = PUNCTUATION_TRANSFORMATION_BY_NAME[transformation](GB_LLOYDS)

			if (variant === GB_LLOYDS) continue

			expect(classifyCaseTransformation(GB_LLOYDS, variant), transformation).toBeNull()
			expect(classifyWhitespaceTransformation(GB_LLOYDS, variant), transformation).toBeNull()
		}
	})
})

describe("punctuationApplicability", () => {
	it("declares exactly three exclusion rules", () => {
		expect([...PUNCTUATION_APPLICABILITY_RULES]).toEqual([
			"identity-transformation",
			"mark-inside-token",
			"text-echoing-comparator",
		])
	})

	it("separates a query with no point from one whose point is part of a name", () => {
		expect(punctuationApplicability(GB_BARE_POSTCODE, "period-removed").rule).toBe("identity-transformation")

		const reading = punctuationApplicability(FR_COMER, "period-removed")

		expect(reading.applicable).toBe(false)
		expect(reading.rule).toBe("mark-inside-token")
		expect(reading.reason).toContain("inside a token")
	})

	it.each(["comma-removed", "apostrophe-typographic", "apostrophe-ascii"] as const)(
		"excludes the committed bare GB postcode from %s — it carries no such mark",
		(transformation) => {
			expect(punctuationApplicability(GB_BARE_POSTCODE, transformation).rule).toBe("identity-transformation")
		}
	)

	it.each([
		["parse_whole_strict", US_MLK],
		["component_map", DE_NIPPES],
	] as const)("refuses period-removed on %s — the span the parser quotes carries the point", (comparator, base) => {
		const reading = punctuationApplicability(base, "period-removed", { comparator })

		expect(reading.applicable).toBe(false)
		expect(reading.rule).toBe("text-echoing-comparator")
		expect(reading.reason).toContain(comparator)
	})

	it("admits period-removed on an identity row — a place id carries no punctuation", () => {
		const reading = punctuationApplicability(GD_ST_GEORGES, "period-removed", { comparator: "resolution_identity" })

		expect(reading.applicable).toBe(true)
	})

	it("refuses comma removal when the row's own asserted span carries the comma", () => {
		const reading = punctuationApplicability("Gate 12, Terminal 2, Manchester", "comma-removed", {
			comparator: "component_map",
			echoedSpans: ["Gate 12, Terminal 2"],
		})

		expect(reading.rule).toBe("text-echoing-comparator")
		expect(reading.reason).toContain("Gate 12, Terminal 2")
	})

	it("admits comma removal on the same comparator when no asserted span carries one", () => {
		expect(
			punctuationApplicability(DE_NIPPES, "comma-removed", {
				comparator: "component_map",
				echoedSpans: ["Neusser Str.", "12", "Nippes", "Köln", "50733"],
			}).applicable
		).toBe(true)
	})

	it("states a reason on the admitting verdict too", () => {
		expect(punctuationApplicability(GB_LLOYDS, "comma-removed").reason).toContain("outside any token")
	})
})

describe("auditPunctuationSuite", () => {
	it("accepts a well-formed row", () => {
		expect(auditPunctuationSuite([fixture()])).toEqual([])
	})

	it("rejects a pair that differs by more than punctuation, printing both blind keys", () => {
		const problems = auditPunctuationSuite([fixture({ variant: "Neusser Strasse 12 Nippes 50733 Köln" })])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("differs by more than punctuation")
		expect(problems[0]).toContain("pn-sample-comma-removed")
	})

	it("rejects a hand-written pair that also dropped the abbreviation point", () => {
		expect(auditPunctuationSuite([fixture({ variant: "Neusser Str 12 Nippes 50733 Köln" })])[0]).toContain(
			"no member of"
		)
	})

	it("rejects an arm the row's own comparator would report", () => {
		const problems = auditPunctuationSuite([
			fixture({
				id: "pn-sample-period-removed",
				variant: PUNCTUATION_TRANSFORMATION_BY_NAME["period-removed"](DE_NIPPES),
			}),
		])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("text-echoing-comparator")
	})

	it("rejects an arm whose mark is part of a name", () => {
		const problems = auditPunctuationSuite([
			fixture({
				id: "pn-sample-inside-token",
				base: FR_COMER,
				variant: "COMER parísméxico",
				context: { caseCountry: "FR" },
				outcomeComparator: "resolution_identity",
			}),
		])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("no member of")
	})

	it("rejects a row with no country — an unrouted row grades against a locale that is not its own", () => {
		expect(auditPunctuationSuite([fixture({ context: undefined })])[0]).toContain("no context.caseCountry")
	})

	it("rejects a row with no committed source", () => {
		expect(auditPunctuationSuite([fixture({ rowRef: undefined })])[0]).toContain("no rowRef")
	})

	it("rejects a relation other than equivalent", () => {
		expect(auditPunctuationSuite([fixture({ expect: "diverges" })])[0]).toContain('expects "diverges"')
	})

	it("rejects a row belonging to another law", () => {
		expect(auditPunctuationSuite([fixture({ law: "whitespace-invariance" })])[0]).toContain(
			'law is "whitespace-invariance"'
		)
	})
})

describe("a seeded punctuation regression", () => {
	/**
	 * The pipeline stand-in that fails ONLY on the comma-removed arm: with the separators gone, the dependent locality
	 * joins the street span. Seeding the regression rather than waiting for one is what proves the failure line carries
	 * enough to diagnose from.
	 */
	const observe: ConformanceObserver = async (query) => {
		const commaless = !query.includes(",")

		return {
			result: {
				components: commaless
					? { street: "Neusser Str. Nippes", house_number: "12", locality: "Köln", postcode: "50733" }
					: {
							street: "Neusser Str.",
							house_number: "12",
							dependent_locality: "Nippes",
							locality: "Köln",
							postcode: "50733",
						},
				lat: null,
				lon: null,
				tier: "admin",
				locality: "Köln",
				region: null,
				country: null,
				postcode: "50733",
				house_number: "12",
				street: commaless ? "Neusser Str. Nippes" : "Neusser Str.",
				venue: null,
				dependent_locality: commaless ? null : "Nippes",
				unit: null,
				postcode_country_scope: null,
				hierarchy: [],
			},
		} satisfies ConformanceOutcome
	}

	it("fails with the row, the transformation, the comparator and the mechanism", async () => {
		const { pass, findings } = await runConformanceFixtures([fixture()], observe)
		const rendered = formatConformanceFinding(findings[0]!)

		expect(pass).toBe(false)

		// The committed row it came from.
		expect(rendered).toContain("cases/de/regression.jsonl#de-r9-nippes-koeln")
		// The comparator and both relations.
		expect(rendered).toContain("component_map expected equivalent, observed diverges")
		// The mechanism: which component moved, how, and how severely.
		expect(rendered).toContain("compareComponents verdict LOST")
		expect(rendered).toContain('street: "Neusser Str." → "Neusser Str. Nippes"')
		// The transformation, which the report line derives rather than storing.
		expect(describePunctuationTransformation(findings[0]!.fixture)).toBe("comma-removed")
	})

	it("holds on the appended full stop, so the failure names the transformation rather than the row", async () => {
		const terminal = PUNCTUATION_TRANSFORMATION_BY_NAME["terminal-period"](DE_NIPPES)

		const { findings } = await runConformanceFixtures(
			[fixture({ id: "pn-sample-terminal-period", variant: terminal })],
			observe
		)

		expect(findings[0]!.held).toBe(true)
		expect(describePunctuationTransformation(findings[0]!.fixture)).toBe("terminal-period")
	})
})
