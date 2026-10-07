/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The key and applicability rule are separate guards. `İstanbul` clears the key check and fails the applicability check.
 *   Each exclusion uses a committed board row instead of a synthetic string.
 */

import { describe, expect, it } from "vitest"

import {
	auditCaseFoldingSuite,
	CASE_APPLICABILITY_RULES,
	CASE_FOLDING_LAW,
	CASE_TRANSFORMATION_BY_NAME,
	CASE_TRANSFORMATIONS,
	caseApplicability,
	caseFoldKey,
	classifyCaseTransformation,
	describeCaseTransformation,
} from "#tools/eval-harness/conformance/case-folding"
import type { ConformanceOutcome } from "#tools/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "#tools/eval-harness/conformance/fixture"
import {
	type ConformanceObserver,
	formatConformanceFinding,
	runConformanceFixtures,
} from "#tools/eval-harness/conformance/run"

/**
 * Quoted verbatim rather than loaded so a failure shows the exact text;
 * `case-folding-suite.test.ts` proves these still match the corpus.
 */
const TR_STREET = "Istiklal Avenue"
const JP_NATIVE = "りんりん, 〒506-0025 岐阜県高山市天満町3丁目 57"
const DE_SHARP_S = "Friedrichstraße"

function fixture(over: Partial<ConformanceFixture> = {}): ConformanceFixture {
	return {
		id: "cf-sample-upper",
		law: CASE_FOLDING_LAW,
		base: "Rue du Faubourg Saint-Honoré",
		variant: "RUE DU FAUBOURG SAINT-HONORÉ",
		context: { caseCountry: "FR" },
		outcomeComparator: "parse_whole_strict",
		expect: "equivalent",
		rowRef: "cases/fr/street-name-boundaries.jsonl#fr-street-name-rue-du-faubourg-saint-honore",
		status: null,
		bugRef: null,
		toleranceM: null,
		note: null,
		...over,
	}
}

describe("case transformations", () => {
	it("closes the set at upper, lower and mixed", () => {
		expect([...CASE_TRANSFORMATIONS]).toEqual(["upper", "lower", "mixed"])
	})

	it("renders the three registers of one committed query", () => {
		const base = "10 Downing Street, London SW1A 2AA"

		expect(CASE_TRANSFORMATION_BY_NAME.upper(base)).toBe("10 DOWNING STREET, LONDON SW1A 2AA")
		expect(CASE_TRANSFORMATION_BY_NAME.lower(base)).toBe("10 downing street, london sw1a 2aa")
		expect(CASE_TRANSFORMATION_BY_NAME.mixed(base)).toBe("10 Downing Street, London Sw1a 2Aa")
	})

	it("capitalizes the first CASED character, not index zero", () => {
		expect(CASE_TRANSFORMATION_BY_NAME.mixed("%ARABICA paris")).toBe("%Arabica Paris")
		expect(CASE_TRANSFORMATION_BY_NAME.mixed("N7 0BT")).toBe("N7 0Bt")
	})

	it("leaves whitespace exactly as it found it, so a mixed pair stays inside this law", () => {
		const spaced = "10  Downing   Street,\tLondon"

		expect(CASE_TRANSFORMATION_BY_NAME.mixed(spaced)).toBe("10  Downing   Street,\tLondon")
	})
})

describe("caseFoldKey", () => {
	it("matches the German sharp s against its uppercase expansion", () => {
		expect(caseFoldKey(DE_SHARP_S)).toBe(caseFoldKey("FRIEDRICHSTRASSE"))
		// A bare lowercase fold does not match the sharp s to its expansion.
		expect(DE_SHARP_S.toLowerCase()).not.toBe("FRIEDRICHSTRASSE".toLowerCase())
	})

	it("matches Greek final sigma against its uppercase form", () => {
		expect(caseFoldKey("ΟΔΟΣ")).toBe(caseFoldKey("οδος"))
	})

	it("separates a normalization change from a case change", () => {
		const nfc = "12 Rue de l’Église"
		const nfd = nfc.normalize("NFD")

		expect(nfd).not.toBe(nfc)
		expect(caseFoldKey(nfd)).not.toBe(caseFoldKey(nfc))
	})

	it.each([
		["punctuation", "Fishburn, Stockton-on-Tees", "Fishburn Stockton-on-Tees"],
		["whitespace", "10 Downing Street", "10  Downing Street"],
		["transliteration", "Köln", "Koeln"],
	])("separates a %s change from a case change", (_label, base, changed) => {
		expect(caseFoldKey(base)).not.toBe(caseFoldKey(changed))
	})
})

describe("classifyCaseTransformation", () => {
	it("names the transformation that produced the variant", () => {
		expect(classifyCaseTransformation("Portland, OR", "PORTLAND, OR")).toBe("upper")
		expect(classifyCaseTransformation("Portland, OR", "portland, or")).toBe("lower")
		expect(classifyCaseTransformation("Portland, OR", "Portland, Or")).toBe("mixed")
	})

	it("refuses an identical pair — that is the identity law, not a case one", () => {
		expect(classifyCaseTransformation("Portland, OR", "Portland, OR")).toBeNull()
	})

	it("refuses a pair that changed more than case", () => {
		expect(classifyCaseTransformation("Portland, OR", "PORTLAND OR")).toBeNull()
	})

	it("refuses a case permutation no named transformation produces", () => {
		expect(caseFoldKey("Portland, OR")).toBe(caseFoldKey("pOrTlAnD, oR"))
		expect(classifyCaseTransformation("Portland, OR", "pOrTlAnD, oR")).toBeNull()
	})
})

describe("caseApplicability", () => {
	it("declares exactly two exclusion rules", () => {
		expect([...CASE_APPLICABILITY_RULES]).toEqual(["identity-transformation", "locale-sensitive-casing"])
	})

	it.each(["upper", "lower"] as const)(
		"excludes the committed Turkish street row from %s, naming the locale rule",
		(transformation) => {
			const reading = caseApplicability(TR_STREET, transformation, "TR")

			expect(reading.applicable).toBe(false)
			expect(reading.rule).toBe("locale-sensitive-casing")
			expect(reading.reason).toContain("dotless")
		}
	)

	it("reports the identity rule first when both bear on the same row", () => {
		// The Turkish row is already title case, so `mixed` changes no character and the identity rule fires first.
		expect(caseApplicability(TR_STREET, "mixed", "TR").rule).toBe("identity-transformation")
	})

	it("excludes the same text under Azeri and admits it under French", () => {
		expect(caseApplicability(TR_STREET, "upper", "AZ").applicable).toBe(false)
		expect(caseApplicability(TR_STREET, "upper", "FR").applicable).toBe(true)
	})

	it("admits a Turkish row whose text carries none of the trigger letters", () => {
		expect(caseApplicability("Sokak", "upper", "TR").applicable).toBe(true)
	})

	it("excludes the committed native-script Japanese row as an identity transformation", () => {
		const reading = caseApplicability(JP_NATIVE, "upper", "JP")

		expect(reading.applicable).toBe(false)
		expect(reading.rule).toBe("identity-transformation")
	})

	it("admits a Japanese row whose text is Latin script — the rule reads the TEXT, never the country", () => {
		expect(caseApplicability("Takeshita Street", "upper", "JP").applicable).toBe(true)
	})

	it("excludes uppercasing a text already written in uppercase", () => {
		expect(caseApplicability("N7 0BT", "upper", "GB").rule).toBe("identity-transformation")
		expect(caseApplicability("N7 0BT", "lower", "GB").applicable).toBe(true)
	})

	it("admits the German sharp s, whose uppercase expansion is the correct German rendering", () => {
		expect(caseApplicability(DE_SHARP_S, "upper", "DE").applicable).toBe(true)
	})

	it("states a reason on the admitting verdict too", () => {
		expect(caseApplicability("Takeshita Street", "lower", "JP").reason).toContain("preserves every letter's identity")
	})
})

describe("auditCaseFoldingSuite", () => {
	it("accepts a well-formed row", () => {
		expect(auditCaseFoldingSuite([fixture()])).toEqual([])
	})

	it("rejects a pair that differs by more than case, printing both fold keys", () => {
		const problems = auditCaseFoldingSuite([fixture({ variant: "RUE DU FAUBOURG SAINT-HONORE" })])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("differs by more than case")
		expect(problems[0]).toContain("cf-sample-upper")
	})

	it.each([
		["punctuation", "RUE DU FAUBOURG SAINT HONORÉ"],
		["whitespace", "RUE  DU  FAUBOURG  SAINT-HONORÉ"],
		["normalization", "RUE DU FAUBOURG SAINT-HONORÉ".normalize("NFD")],
	])("keeps a %s change out of this law", (_label, variant) => {
		expect(auditCaseFoldingSuite([fixture({ variant })])[0]).toContain("differs by more than case")
	})

	it("rejects a locale-inapplicable row rather than letting it run and fail", () => {
		const problems = auditCaseFoldingSuite([
			fixture({ base: TR_STREET, variant: TR_STREET.toUpperCase(), context: { caseCountry: "TR" } }),
		])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("locale-sensitive-casing")
	})

	it("rejects a row with no country — an unrouted row grades against a locale that is not its own", () => {
		expect(auditCaseFoldingSuite([fixture({ context: null })])[0]).toContain("no context.caseCountry")
	})

	it("rejects a row with no committed source", () => {
		expect(auditCaseFoldingSuite([fixture({ rowRef: null })])[0]).toContain("no rowRef")
	})

	it("rejects a relation other than equivalent", () => {
		const problems = auditCaseFoldingSuite([fixture({ expect: "diverges" })])

		expect(problems[0]).toContain('expects "diverges"')
	})

	it("rejects a row belonging to another law", () => {
		expect(auditCaseFoldingSuite([fixture({ law: "whitespace-invariance" })])[0]).toContain(
			'law is "whitespace-invariance"'
		)
	})
})

describe("a seeded case regression", () => {
	/**
	 * Fails only on the uppercase arm, the shape both live findings take, so the failure
	 * line is exercised without waiting for a real regression.
	 */
	const observe: ConformanceObserver = async (query) => {
		const upper = query === query.toUpperCase()

		return {
			result: {
				components: upper
					? { street: "DU FAUBOURG SAINT-HONORÉ", street_prefix: "RUE", locality: "RUE" }
					: { street: "du Faubourg Saint-Honoré", street_prefix: "Rue" },
				lat: null,
				lon: null,
				tier: "admin",
				locality: upper ? "RUE" : null,
				region: null,
				country: null,
				postcode: null,
				house_number: null,
				street: null,
				venue: null,
				dependent_locality: null,
				unit: null,
				postcode_country_scope: null,
				capital_promotion: null,
				variant_alias_exemption: null,
				admin_coherence: null,
				hierarchy: [],
			},
		} satisfies ConformanceOutcome
	}

	it("fails with the row, the transformation, the comparator and the mechanism", async () => {
		const { pass, findings } = await runConformanceFixtures([fixture()], observe)
		const rendered = formatConformanceFinding(findings[0]!)

		expect(pass).toBe(false)

		expect(rendered).toContain("cases/fr/street-name-boundaries.jsonl#fr-street-name-rue-du-faubourg-saint-honore")
		expect(rendered).toContain("parse_whole_strict expected equivalent, observed diverges")
		expect(rendered).toContain('locality: ∅ → "RUE"')
		// The report line derives the transformation instead of storing it.
		expect(describeCaseTransformation(findings[0]!.fixture)).toBe("upper")
	})

	it("holds on the lower arm, so the failure names the transformation rather than the row", async () => {
		const lower = CASE_TRANSFORMATION_BY_NAME.lower(fixture().base)
		const { findings } = await runConformanceFixtures([fixture({ id: "cf-sample-lower", variant: lower })], observe)

		expect(findings[0]!.held).toBe(true)
		expect(describeCaseTransformation(findings[0]!.fixture)).toBe("lower")
	})
})
