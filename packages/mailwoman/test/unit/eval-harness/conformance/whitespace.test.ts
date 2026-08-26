/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The whitespace law's two guards, and the failure line a violation produces.
 *
 *   The load-bearing pair is `whitespaceBlindKey` and `whitespaceApplicability`, and the reason both exist is
 *   here in executable form: the key refuses a pair that changed anything besides whitespace, and the
 *   applicability rules refuse a pair the key ACCEPTS but whose spacing the transformation could never have
 *   moved. A space swapped for a newline clears the first and is refused by neither — it is refused because
 *   no NAMED transformation produces it, which is how this law keeps the segmentation grammar out.
 *
 *   Every exclusion is exercised against a real committed board row rather than an invented string: the bare
 *   GB unit code, whose only space belongs to the code, and the single-token Polish row, which has no
 *   internal space at all. A rule demonstrated only on a synthetic input has not been shown to apply to
 *   anything the repo holds.
 */

import type { ConformanceOutcome } from "mailwoman/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "mailwoman/eval-harness/conformance/fixture"
import {
	type ConformanceObserver,
	formatConformanceFinding,
	runConformanceFixtures,
} from "mailwoman/eval-harness/conformance/run"
import {
	auditWhitespaceSuite,
	classifyWhitespaceTransformation,
	describeWhitespaceTransformation,
	structuralIdentifierSpaces,
	WHITESPACE_APPLICABILITY_RULES,
	WHITESPACE_LAW,
	WHITESPACE_TRANSFORMATION_BY_NAME,
	WHITESPACE_TRANSFORMATION_SCOPE,
	WHITESPACE_TRANSFORMATIONS,
	whitespaceApplicability,
	whitespaceBlindKey,
} from "mailwoman/eval-harness/conformance/whitespace"
import { describe, expect, it } from "vitest"

/**
 * Committed board inputs, verbatim. Quoted here rather than loaded so a test failure shows the exact text under
 * discussion; `whitespace-suite.test.ts` is what proves the suite's own rows still match the corpus.
 */
const GB_DOWNING = "10 Downing Street, London SW1A 2AA"
const GB_BARE_POSTCODE = "N7 0BT"
const PL_SINGLE_TOKEN = "Kraków"
const FR_STREET = "Rue du Faubourg Saint-Honoré"

function fixture(over: Partial<ConformanceFixture> = {}): ConformanceFixture {
	return {
		id: "ws-sample-tabbed",
		law: WHITESPACE_LAW,
		base: FR_STREET,
		variant: WHITESPACE_TRANSFORMATION_BY_NAME.tabbed(FR_STREET),
		context: { caseCountry: "FR" },
		outcomeComparator: "parse_whole_strict",
		expect: "equivalent",
		rowRef: "cases/fr/street-name-boundaries.jsonl#fr-street-name-rue-du-faubourg-saint-honore",
		...over,
	}
}

describe("whitespace transformations", () => {
	it("closes the set at six, and gives each one a scope", () => {
		expect([...WHITESPACE_TRANSFORMATIONS]).toEqual([
			"leading",
			"trailing",
			"repeated",
			"tabbed",
			"separator-tightened",
			"separator-loosened",
		])

		for (const transformation of WHITESPACE_TRANSFORMATIONS) {
			expect(WHITESPACE_TRANSFORMATION_SCOPE[transformation]).toBeTruthy()
		}
	})

	it("renders the six registers of one committed query", () => {
		expect(WHITESPACE_TRANSFORMATION_BY_NAME.leading(GB_DOWNING)).toBe(" 10 Downing Street, London SW1A 2AA")
		expect(WHITESPACE_TRANSFORMATION_BY_NAME.trailing(GB_DOWNING)).toBe("10 Downing Street, London SW1A 2AA ")
		expect(WHITESPACE_TRANSFORMATION_BY_NAME.repeated(GB_DOWNING)).toBe("10  Downing  Street,  London  SW1A 2AA")
		expect(WHITESPACE_TRANSFORMATION_BY_NAME.tabbed(GB_DOWNING)).toBe("10\tDowning\tStreet,\tLondon\tSW1A 2AA")

		expect(WHITESPACE_TRANSFORMATION_BY_NAME["separator-tightened"](GB_DOWNING)).toBe(
			"10 Downing Street,London SW1A 2AA"
		)

		expect(WHITESPACE_TRANSFORMATION_BY_NAME["separator-loosened"](GB_DOWNING)).toBe(
			"10 Downing Street , London SW1A 2AA"
		)
	})

	it("leaves the postcode's own space alone on both run transformations", () => {
		// The two renderings above already show it; asserted here as the claim rather than as a side effect of a longer
		// string, because it is the whole reason the run transformations are not a plain `replaceAll`.
		expect(WHITESPACE_TRANSFORMATION_BY_NAME.repeated(GB_DOWNING)).toContain("SW1A 2AA")
		expect(WHITESPACE_TRANSFORMATION_BY_NAME.tabbed(GB_DOWNING)).toContain("SW1A 2AA")
		expect(WHITESPACE_TRANSFORMATION_BY_NAME.repeated(GB_BARE_POSTCODE)).toBe(GB_BARE_POSTCODE)
	})

	it("leaves case and punctuation exactly as it found them, so a pair stays inside this law", () => {
		for (const transformation of WHITESPACE_TRANSFORMATIONS) {
			const variant = WHITESPACE_TRANSFORMATION_BY_NAME[transformation](GB_DOWNING)

			expect(whitespaceBlindKey(variant), transformation).toBe(whitespaceBlindKey(GB_DOWNING))
		}
	})
})

describe("structuralIdentifierSpaces", () => {
	it("names the GB unit code whose space it found", () => {
		expect(structuralIdentifierSpaces(GB_DOWNING)).toEqual(["SW1A 2AA"])
		expect(structuralIdentifierSpaces(GB_BARE_POSTCODE)).toEqual(["N7 0BT"])
	})

	it.each([
		["4900 Airport Pkwy, Addison TX 75001"],
		["12 Rue de Rivoli, 75001 Paris"],
		["Unter den Linden 77, 10117 Berlin"],
		["Biggin Hill, United Kingdom"],
	])("finds none in %s — a five-digit code carries no internal space", (input) => {
		expect(structuralIdentifierSpaces(input)).toEqual([])
	})
})

describe("whitespaceBlindKey", () => {
	it("matches a query against every one of its own whitespace variants", () => {
		expect(whitespaceBlindKey(" 10  Downing\tStreet ,London\tSW1A  2AA ")).toBe(whitespaceBlindKey(GB_DOWNING))
	})

	it("matches a newline swap too — the key is what lets the CLASSIFIER refuse it by name", () => {
		expect(whitespaceBlindKey("Portland,\nOR")).toBe(whitespaceBlindKey("Portland, OR"))
		expect(classifyWhitespaceTransformation("Portland, OR", "Portland,\nOR")).toBeNull()
	})

	it.each([
		["case", "Portland, OR", "portland, or"],
		["punctuation", "Fishburn, Stockton-on-Tees", "Fishburn Stockton-on-Tees"],
		["transliteration", "Köln", "Koeln"],
	])("separates a %s change from a whitespace change", (_label, base, changed) => {
		expect(whitespaceBlindKey(base)).not.toBe(whitespaceBlindKey(changed))
	})
})

describe("classifyWhitespaceTransformation", () => {
	it.each([...WHITESPACE_TRANSFORMATIONS])("names %s from the pair alone", (transformation) => {
		const variant = WHITESPACE_TRANSFORMATION_BY_NAME[transformation](GB_DOWNING)

		expect(classifyWhitespaceTransformation(GB_DOWNING, variant)).toBe(transformation)
	})

	it("refuses an identical pair — that is the identity law, not a whitespace one", () => {
		expect(classifyWhitespaceTransformation(GB_DOWNING, GB_DOWNING)).toBeNull()
	})

	it("refuses a pair that changed more than whitespace", () => {
		expect(classifyWhitespaceTransformation("Portland, OR", "Portland OR")).toBeNull()
	})

	it("refuses a whitespace permutation no named transformation produces", () => {
		expect(whitespaceBlindKey("Portland, OR")).toBe(whitespaceBlindKey("Portland,   OR"))
		expect(classifyWhitespaceTransformation("Portland, OR", "Portland,   OR")).toBeNull()
	})
})

describe("whitespaceApplicability", () => {
	it("declares exactly two exclusion rules", () => {
		expect([...WHITESPACE_APPLICABILITY_RULES]).toEqual(["identity-transformation", "structural-identifier-space"])
	})

	it.each(["repeated", "tabbed"] as const)(
		"excludes the committed bare GB postcode from %s, naming the identifier",
		(transformation) => {
			const reading = whitespaceApplicability(GB_BARE_POSTCODE, transformation)

			expect(reading.applicable).toBe(false)
			expect(reading.rule).toBe("structural-identifier-space")
			expect(reading.reason).toContain("N7 0BT")
		}
	)

	it("separates a query with no spacing from one whose spacing is load-bearing", () => {
		expect(whitespaceApplicability(PL_SINGLE_TOKEN, "repeated").rule).toBe("identity-transformation")
		expect(whitespaceApplicability(GB_BARE_POSTCODE, "repeated").rule).toBe("structural-identifier-space")
	})

	it.each(["separator-tightened", "separator-loosened"] as const)(
		"excludes a comma-less committed row from %s",
		(transformation) => {
			const reading = whitespaceApplicability(FR_STREET, transformation)

			expect(reading.applicable).toBe(false)
			expect(reading.rule).toBe("identity-transformation")
			expect(reading.reason).toContain("no comma")
		}
	)

	it.each(["leading", "trailing"] as const)("admits %s on every shape, including a single token", (transformation) => {
		expect(whitespaceApplicability(PL_SINGLE_TOKEN, transformation).applicable).toBe(true)
		expect(whitespaceApplicability(GB_BARE_POSTCODE, transformation).applicable).toBe(true)
	})

	it("admits a run transformation the moment ONE safe run exists beside the identifier", () => {
		expect(whitespaceApplicability(GB_DOWNING, "repeated").applicable).toBe(true)
	})

	it("states a reason on the admitting verdict too", () => {
		expect(whitespaceApplicability(GB_DOWNING, "tabbed").reason).toContain("outside any identifier")
	})
})

describe("auditWhitespaceSuite", () => {
	it("accepts a well-formed row", () => {
		expect(auditWhitespaceSuite([fixture()])).toEqual([])
	})

	it("rejects a pair that differs by more than whitespace, printing both blind keys", () => {
		const problems = auditWhitespaceSuite([fixture({ variant: "Rue du Faubourg Saint-Honore" })])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("differs by more than whitespace")
		expect(problems[0]).toContain("ws-sample-tabbed")
	})

	it.each([
		["case", "RUE DU FAUBOURG SAINT-HONORÉ"],
		["normalization", "Rue du Faubourg Saint-Honoré".normalize("NFD")],
	])("keeps a %s change out of this law", (_label, variant) => {
		expect(auditWhitespaceSuite([fixture({ variant })])[0]).toContain("differs by more than whitespace")
	})

	it("keeps a newline swap out of this law — it re-segments rather than re-spaces", () => {
		const problems = auditWhitespaceSuite([fixture({ variant: "Rue du Faubourg\nSaint-Honoré" })])

		expect(problems[0]).toContain("no member of")
	})

	it("accepts a boundary arm on the bare postcode — the exclusion is per transformation, not per row", () => {
		expect(
			auditWhitespaceSuite([
				fixture({ base: GB_BARE_POSTCODE, variant: `${GB_BARE_POSTCODE} `, context: { caseCountry: "GB" } }),
			])
		).toEqual([])
	})

	it("rejects a hand-written pair that doubled the postcode's own space", () => {
		const problems = auditWhitespaceSuite([
			fixture({ base: GB_BARE_POSTCODE, variant: "N7  0BT", context: { caseCountry: "GB" } }),
		])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("no member of")
	})

	it("rejects a row with no country — an unrouted row grades against a locale that is not its own", () => {
		expect(auditWhitespaceSuite([fixture({ context: undefined })])[0]).toContain("no context.caseCountry")
	})

	it("rejects a row with no committed source", () => {
		expect(auditWhitespaceSuite([fixture({ rowRef: undefined })])[0]).toContain("no rowRef")
	})

	it("rejects a relation other than equivalent", () => {
		expect(auditWhitespaceSuite([fixture({ expect: "diverges" })])[0]).toContain('expects "diverges"')
	})

	it("rejects a row belonging to another law", () => {
		expect(auditWhitespaceSuite([fixture({ law: "case-folding-invariance" })])[0]).toContain(
			'law is "case-folding-invariance"'
		)
	})
})

describe("a seeded whitespace regression", () => {
	/**
	 * The pipeline stand-in that fails ONLY on the tabbed arm — the shape the live finding takes. Seeding the regression
	 * rather than waiting for one is what proves the failure line carries enough to diagnose from.
	 */
	const observe: ConformanceObserver = async (query) => {
		const tabbed = query.includes("\t")

		return {
			result: {
				components: tabbed
					? { street: "du\tFaubourg", street_prefix: "Rue", locality: "Saint-Honoré" }
					: { street: "du Faubourg Saint-Honoré", street_prefix: "Rue" },
				lat: null,
				lon: null,
				tier: "admin",
				locality: tabbed ? "Saint-Honoré" : null,
				region: null,
				country: null,
				postcode: null,
				house_number: null,
				street: null,
				venue: null,
				dependent_locality: null,
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
		expect(rendered).toContain("cases/fr/street-name-boundaries.jsonl#fr-street-name-rue-du-faubourg-saint-honore")
		// The comparator and both relations.
		expect(rendered).toContain("parse_whole_strict expected equivalent, observed diverges")
		// The mechanism: which component moved, and how.
		expect(rendered).toContain('locality: ∅ → "Saint-Honoré"')
		// The transformation, which the report line derives rather than storing.
		expect(describeWhitespaceTransformation(findings[0]!.fixture)).toBe("tabbed")
	})

	it("holds on the repeated arm, so the failure names the transformation rather than the row", async () => {
		const repeated = WHITESPACE_TRANSFORMATION_BY_NAME.repeated(FR_STREET)

		const { findings } = await runConformanceFixtures(
			[fixture({ id: "ws-sample-repeated", variant: repeated })],
			observe
		)

		expect(findings[0]!.held).toBe(true)
		expect(describeWhitespaceTransformation(findings[0]!.fixture)).toBe("repeated")
	})
})
