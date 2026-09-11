/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical-form law's guard, its two exclusion rules, and the failure line a violation produces.
 *
 *   THE GUARD IS THE SCOPE. `canonicalFormKey` is `NFD`, so a pair whose decompositions match is canonically
 *   equivalent and a pair whose decompositions differ is not — which is the whole of what this law claims, and
 *   the reason the relations it must NOT absorb are refused by construction rather than by a list.
 *   Compatibility normalization, a removed accent, a transliteration and a case change each move the key, and
 *   each is asserted here to move it.
 *
 *   INDEPENDENCE IS ASSERTED IN BOTH DIRECTIONS, and that is what makes a seeded normalization regression
 *   attributable. A case, spacing or punctuation change is refused by this law's audit, and a canonical-form
 *   pair is refused by the other three classifiers — so a failing arm here cannot be a mis-filed row from
 *   another suite, and no other suite can absorb this one.
 *
 *   NO DECOMPOSED STRING IS TYPED IN THIS FILE, and `nfc-nfd-suite.test.ts` holds that line for the whole
 *   directory. The composed and decomposed spellings of `Köln` render identically, so a hand-typed decomposed
 *   literal is a value a reviewer cannot check and an editor can silently rewrite. Every one is built from a
 *   composed literal by the law's own transformation, and a decomposition's CONTENT is stated in code points.
 *
 *   Every case is stated over a real committed board input rather than an invented string: the Cologne row for
 *   the umlaut, the Paris street for the acute and the typographic apostrophe it must leave alone, the Hanoi
 *   row for a base letter carrying two stacked marks, the Paris venue for a Hangul syllable, the Vienna street
 *   for the letter that has no canonical decomposition at all, and the bare GB unit code for a query with no
 *   canonical variance to state.
 */

import { normalize } from "@mailwoman/normalize"
import { classifyCaseTransformation } from "mailwoman/eval-harness/conformance/case-folding"
import type { ConformanceOutcome } from "mailwoman/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditCanonicalFormSuite,
	CANONICAL_APPLICABILITY_RULES,
	CANONICAL_FORM_LAW,
	CANONICAL_FORM_STATES,
	CANONICAL_FORMS,
	CANONICAL_TRANSFORMATION_BY_NAME,
	canonicalApplicability,
	canonicalFormCoverage,
	canonicalFormKey,
	canonicalFormState,
	canonicallyVariant,
	classifyCanonicalTransformation,
	describeCanonicalFormCoverage,
	describeCanonicalTransformation,
} from "mailwoman/eval-harness/conformance/nfc-nfd"
import { classifyPunctuationTransformation } from "mailwoman/eval-harness/conformance/punctuation"
import {
	type ConformanceObserver,
	formatConformanceFinding,
	runConformanceFixtures,
} from "mailwoman/eval-harness/conformance/run"
import { classifyWhitespaceTransformation } from "mailwoman/eval-harness/conformance/whitespace"
import { describe, expect, it } from "vitest"

/**
 * Committed board inputs, verbatim. Quoted here rather than loaded so a test failure shows the exact text under
 * discussion; `nfc-nfd-suite.test.ts` is what proves the suite's own rows still match the corpus.
 */
const DE_NIPPES = "Neusser Str. 12, Nippes, 50733 Köln"
const FR_OPERA = "Avenue de l’Opéra"
const VN_LY_THAI_TO = "12 Lý Thái Tổ, Hoàn Kiếm, Hà Nội"
const FR_JJAN = "JJAN! 짠 Châtelet, 14 Rue du Pont Neuf, 75001 Paris"
const AT_KARNTNER = "Kärntner Straße"
const GB_BARE_POSTCODE = "N7 0BT"

const decompose = CANONICAL_TRANSFORMATION_BY_NAME.nfd
const compose = CANONICAL_TRANSFORMATION_BY_NAME.nfc

/**
 * The Hanoi row with its FIRST accented word decomposed and every later one left composed — a query written in NEITHER
 * canonical form, and therefore canonically equivalent to the base while being reproducible from neither
 * transformation's name. It is the shape a string assembled from two differently-normalized sources arrives in.
 */
const VN_PARTLY = VN_LY_THAI_TO.replace("Lý", decompose("Lý"))

/**
 * A string's code points, hex, space-separated. The only reviewable way to state what a decomposition produced.
 */
function codePoints(text: string): string {
	return [...text].map((character) => character.codePointAt(0)!.toString(16).padStart(4, "0")).join(" ")
}

function fixture(over: Partial<ConformanceFixture> = {}): ConformanceFixture {
	return {
		id: "nf-sample-nfd",
		law: CANONICAL_FORM_LAW,
		base: DE_NIPPES,
		variant: decompose(DE_NIPPES),
		context: { caseCountry: "DE" },
		outcomeComparator: "parse_whole_strict",
		expect: "equivalent",
		rowRef: "cases/de/regression.jsonl#de-r9-nippes-koeln",
		...over,
	}
}

describe("the canonical forms", () => {
	it("closes the set at two, and names the three states a query can be written in", () => {
		expect([...CANONICAL_FORMS]).toEqual(["nfd", "nfc"])
		expect([...CANONICAL_FORM_STATES]).toEqual(["nfc", "nfd", "mixed"])
	})

	it("splits a composed umlaut into a base letter and a combining mark, and composes it back", () => {
		const decomposed = decompose(DE_NIPPES)

		expect(codePoints(decompose("ö"))).toBe("006f 0308")
		expect(decomposed).not.toBe(DE_NIPPES)
		expect(decomposed).not.toContain("Köln")
		expect([...decomposed]).toHaveLength([...DE_NIPPES].length + 1)
		expect(compose(decomposed)).toBe(DE_NIPPES)
	})

	it("leaves the typographic apostrophe exactly where it found it — that mark is another law's", () => {
		expect(decompose(FR_OPERA)).toContain("l’")
		expect(classifyPunctuationTransformation(FR_OPERA, decompose(FR_OPERA))).toBeNull()
	})

	it("splits a base letter carrying two stacked marks into three code points", () => {
		// Vietnamese Ổ is O plus a circumflex plus a hook above, so this query's decomposition grows by more than
		// one mark per accented letter — the shape a one-mark-per-letter assumption gets wrong.
		expect(codePoints(decompose("Ổ"))).toBe("004f 0302 0309")
		expect([...decompose(VN_LY_THAI_TO)].length).toBeGreaterThan([...VN_LY_THAI_TO].length + 1)
	})

	it("splits a Hangul syllable into jamo, which is an algorithm rather than a table lookup", () => {
		expect(codePoints(decompose("짠"))).toBe("110d 1161 11ab")
		expect(compose(decompose(FR_JJAN))).toBe(FR_JJAN)
	})

	it("leaves a letter that has no canonical decomposition alone, in a query where another letter has one", () => {
		const decomposed = decompose(AT_KARNTNER)

		expect(codePoints(decompose("ß"))).toBe("00df")
		expect(decomposed).toContain("ß")
		expect(decomposed).not.toContain("Kärntner")
		expect([...decomposed]).toHaveLength([...AT_KARNTNER].length + 1)
	})

	it("moves nothing at all on a query with no canonical variance", () => {
		expect(canonicallyVariant(GB_BARE_POSTCODE)).toBe(false)
		expect(decompose(GB_BARE_POSTCODE)).toBe(GB_BARE_POSTCODE)
		expect(compose(GB_BARE_POSTCODE)).toBe(GB_BARE_POSTCODE)
	})

	it("reads which form a query is already written in", () => {
		expect(canonicalFormState(DE_NIPPES)).toBe("nfc")
		expect(canonicalFormState(decompose(DE_NIPPES))).toBe("nfd")
		expect(canonicalFormState(VN_PARTLY)).toBe("mixed")
		expect(canonicalFormState(GB_BARE_POSTCODE)).toBe("nfc")
	})
})

describe("canonicalFormKey", () => {
	it("matches a query against its own decomposition, and against a partly decomposed copy", () => {
		expect(canonicalFormKey(decompose(DE_NIPPES))).toBe(canonicalFormKey(DE_NIPPES))
		expect(canonicalFormKey(VN_PARTLY)).toBe(canonicalFormKey(VN_LY_THAI_TO))
	})

	it.each([
		["compatibility ligature", "ﬁ Straße", "fi Straße"],
		["compatibility numeral", "Ⅻ Rue", "XII Rue"],
		["compatibility digit", "１ Rue", "1 Rue"],
		["accent removal", "Köln", "Koln"],
		["transliteration", "Köln", "Koeln"],
		["case", DE_NIPPES, DE_NIPPES.toUpperCase()],
		["spacing", DE_NIPPES, DE_NIPPES.replace(", Nippes", ",  Nippes")],
		["punctuation", DE_NIPPES, DE_NIPPES.replaceAll(",", "")],
	])("separates a %s change from a canonical-form change", (_label, base, changed) => {
		expect(canonicalFormKey(base)).not.toBe(canonicalFormKey(changed))
	})
})

describe("classifyCanonicalTransformation", () => {
	it("names nfd from an NFC pair, and nfc from an NFD one", () => {
		expect(classifyCanonicalTransformation(DE_NIPPES, decompose(DE_NIPPES))).toBe("nfd")
		expect(classifyCanonicalTransformation(decompose(DE_NIPPES), DE_NIPPES)).toBe("nfc")
	})

	it("refuses an identical pair — that is the identity law, not a canonical-form one", () => {
		expect(classifyCanonicalTransformation(DE_NIPPES, DE_NIPPES)).toBeNull()
		expect(classifyCanonicalTransformation(GB_BARE_POSTCODE, GB_BARE_POSTCODE)).toBeNull()
	})

	it("refuses a canonically equivalent pair no named transformation produces", () => {
		expect(canonicalFormKey(VN_PARTLY)).toBe(canonicalFormKey(VN_LY_THAI_TO))
		expect(classifyCanonicalTransformation(VN_LY_THAI_TO, VN_PARTLY)).toBeNull()
	})

	it.each([
		["compatibility", "ﬁ Straße", "fi Straße"],
		["accent removal", "Köln", "Koln"],
		["case", DE_NIPPES, DE_NIPPES.toLowerCase()],
	])("refuses a %s pair — it is not canonical equivalence", (_label, base, changed) => {
		expect(classifyCanonicalTransformation(base, changed)).toBeNull()
	})
})

describe("independence from the other three laws", () => {
	it("is refused, by the other three classifiers, for the arm it states", () => {
		for (const base of [DE_NIPPES, FR_OPERA, VN_LY_THAI_TO, AT_KARNTNER]) {
			const variant = decompose(base)

			expect(classifyCaseTransformation(base, variant), base).toBeNull()
			expect(classifyWhitespaceTransformation(base, variant), base).toBeNull()
			expect(classifyPunctuationTransformation(base, variant), base).toBeNull()
		}
	})

	it.each([
		["case", DE_NIPPES.toUpperCase()],
		["spacing", DE_NIPPES.replace(", Nippes", ",  Nippes")],
		["punctuation", DE_NIPPES.replaceAll(",", "")],
	])("refuses, in this law, a variant that only changed %s", (_label, variant) => {
		expect(auditCanonicalFormSuite([fixture({ variant })])[0]).toContain("NOT canonically equivalent")
	})
})

describe("canonicalApplicability", () => {
	it("declares exactly two exclusion rules", () => {
		expect([...CANONICAL_APPLICABILITY_RULES]).toEqual(["no-canonical-variance", "already-in-target-form"])
	})

	it.each([...CANONICAL_FORMS])("refuses %s on a query with no canonical variance", (form) => {
		const reading = canonicalApplicability(GB_BARE_POSTCODE, form)

		expect(reading.applicable).toBe(false)
		expect(reading.rule).toBe("no-canonical-variance")
		expect(reading.reason).toContain("same bytes")
	})

	it("refuses the compose arm on a composed query, and names the arm the row does state", () => {
		const reading = canonicalApplicability(DE_NIPPES, "nfc")

		expect(reading.applicable).toBe(false)
		expect(reading.rule).toBe("already-in-target-form")
		expect(reading.reason).toContain('"nfd"')
	})

	it("refuses the decompose arm on a decomposed query, symmetrically", () => {
		const reading = canonicalApplicability(decompose(DE_NIPPES), "nfd")

		expect(reading.rule).toBe("already-in-target-form")
		expect(reading.reason).toContain('"nfc"')
	})

	it("admits each arm on a query written in the other form, and states a reason for admitting it", () => {
		expect(canonicalApplicability(DE_NIPPES, "nfd").applicable).toBe(true)
		expect(canonicalApplicability(decompose(DE_NIPPES), "nfc").applicable).toBe(true)
		expect(canonicalApplicability(DE_NIPPES, "nfd").reason).toContain("canonical order")
	})

	it("admits BOTH arms on a partly decomposed query — it is written in neither form", () => {
		for (const form of CANONICAL_FORMS) {
			expect(canonicalApplicability(VN_PARTLY, form).applicable, form).toBe(true)
		}
	})
})

describe("auditCanonicalFormSuite", () => {
	it("accepts a well-formed row", () => {
		expect(auditCanonicalFormSuite([fixture()])).toEqual([])
	})

	it("rejects a pair that is not canonically equivalent, printing both decompositions", () => {
		const problems = auditCanonicalFormSuite([fixture({ variant: "Neusser Str. 12, Nippes, 50733 Koln" })])

		expect(problems).toHaveLength(1)
		expect(problems[0]).toContain("NOT canonically equivalent")
		expect(problems[0]).toContain("nf-sample-nfd")
	})

	it("rejects a canonically equivalent pair the two named transformations do not produce", () => {
		const row = fixture({ base: VN_LY_THAI_TO, variant: VN_PARTLY, context: { caseCountry: "VN" } })

		expect(auditCanonicalFormSuite([row])[0]).toContain("is neither of")
	})

	it("rejects a row with no country — an unrouted row grades against a locale that is not its own", () => {
		expect(auditCanonicalFormSuite([fixture({ context: undefined })])[0]).toContain("no context.caseCountry")
	})

	it("rejects a row with no committed source", () => {
		expect(auditCanonicalFormSuite([fixture({ rowRef: undefined })])[0]).toContain("no rowRef")
	})

	it("rejects a relation other than equivalent", () => {
		expect(auditCanonicalFormSuite([fixture({ expect: "diverges" })])[0]).toContain('expects "diverges"')
	})

	it("rejects a row belonging to another law", () => {
		expect(auditCanonicalFormSuite([fixture({ law: "punctuation-invariance" })])[0]).toContain(
			'law is "punctuation-invariance"'
		)
	})
})

describe("the coverage reading", () => {
	const corpus = [DE_NIPPES, FR_OPERA, GB_BARE_POSTCODE, "Portland, OR", decompose(AT_KARNTNER)]

	it("divides transformed rows by ELIGIBLE rows, not by rows read", () => {
		const coverage = canonicalFormCoverage([fixture()], corpus)

		expect(coverage.read).toBe(5)
		expect(coverage.eligible).toBe(3)
		expect(coverage.transformed).toBe(1)
	})

	it("counts the eligible population by the form it is already written in", () => {
		expect(canonicalFormCoverage([], corpus).eligibleByState).toEqual({ nfc: 2, nfd: 1, mixed: 0 })
	})

	it("counts a committed row once however many arms the suite states over it", () => {
		const arms = [fixture(), fixture({ id: "nf-sample-nfd-again" })]

		expect(canonicalFormCoverage(arms, corpus).transformed).toBe(1)
	})

	it("counts two committed rows that carry the same query text as two", () => {
		const twin = fixture({ id: "nf-sample-twin-nfd", rowRef: "cases/de/regression.jsonl#de-twin" })

		expect(canonicalFormCoverage([fixture(), twin], corpus).transformed).toBe(2)
	})

	it("prints the ratio and the denominator's own breakdown", () => {
		const line = describeCanonicalFormCoverage([fixture()], corpus)

		expect(line).toContain("1/3 eligible committed rows transformed")
		expect(line).toContain("3 of 5 rows read")
		expect(line).toContain("nfc 2, nfd 1, mixed 0")
	})
})

describe("a seeded normalization regression", () => {
	/**
	 * Two pipeline stand-ins differing in one thing: whether Stage 1 composed before the parse.
	 *
	 * The leaky one echoes the query's own bytes into the component values, which is what a pipeline that skipped NFC
	 * produces; the composing one applies Stage 1 first, which is what the shipped one does. Seeding the regression
	 * rather than waiting for one is what proves the failure line carries enough to diagnose from — and running one
	 * fixture through both is what shows the reading is about Stage 1 rather than about the row.
	 */
	function observer(stage1: (query: string) => string): ConformanceObserver {
		return async (query) => {
			const text = stage1(query)
			const locality = text.slice(text.lastIndexOf(" ") + 1)

			return {
				result: {
					components: { street: "Neusser Str.", house_number: "12", locality, postcode: "50733" },
					lat: null,
					lon: null,
					tier: "admin",
					locality,
					region: null,
					country: null,
					postcode: "50733",
					house_number: "12",
					street: "Neusser Str.",
					venue: null,
					dependent_locality: "Nippes",
					unit: null,
					postcode_country_scope: null,
					hierarchy: [],
				},
			} satisfies ConformanceOutcome
		}
	}

	const leaky = observer((query) => query)
	const composing = observer((query) => normalize(query).normalized)

	it("fails with the row, the transformation, the comparator and the component that moved", async () => {
		const { pass, findings } = await runConformanceFixtures([fixture()], leaky)
		const rendered = formatConformanceFinding(findings[0]!)

		expect(pass).toBe(false)

		// The committed row it came from.
		expect(rendered).toContain("cases/de/regression.jsonl#de-r9-nippes-koeln")
		// The comparator and both relations.
		expect(rendered).toContain("parse_whole_strict expected equivalent, observed diverges")
		// The component that moved, with both byte forms on the line.
		expect(rendered).toContain(`locality: "Köln" → "${decompose("Köln")}"`)
		// The transformation, which the report line derives rather than storing.
		expect(describeCanonicalTransformation(findings[0]!.fixture)).toBe("nfd")
	})

	it("holds once Stage 1 composes, which is what names the stage a live violation would point at", async () => {
		const { pass, findings } = await runConformanceFixtures([fixture()], composing)

		expect(pass).toBe(true)
		expect(findings[0]!.held).toBe(true)
	})

	it("converges the two forms in Stage 1 itself, so a downstream violation is a downstream defect", () => {
		for (const base of [DE_NIPPES, FR_OPERA, VN_LY_THAI_TO, FR_JJAN, AT_KARNTNER]) {
			expect(normalize(decompose(base)).normalized, base).toBe(normalize(base).normalized)
		}
	})
})
