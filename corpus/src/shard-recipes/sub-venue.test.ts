/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture rung of the `sub-venue` recipe's verification ladder (fixtures → smoke → full build).
 *
 *   What is pinned here is the part no downstream count can catch. A composition report tells you the
 *   shard has 84,000 positives; it cannot tell you that one of them is a bare `Halle`, which the
 *   de-DE board says is a city of 240,000 people. So the promotion gate, the `identifier-required`
 *   shape constraint, the per-REGION identifier draw and the word-boundary rule that separates
 *   `Gate` from `Briggate` are asserted directly, against the committed lexicon.
 */

import { SUBVENUE_PROMOTIONS } from "@mailwoman/corpus/tools"
import { describe, expect, it } from "vitest"

import { makeMulberry32 } from "./scaffold.ts"
import {
	allocate,
	buildIdentifierModel,
	buildSubVenueForm,
	buildStreetNegatives,
	containsPhrase,
	defaultLexiconPath,
	hasPromotedShape,
	isBoardReserved,
	isSignIdentifier,
	matchesPromotedShape,
	promotedSurfacesFor,
	readSubVenueLexicon,
	sampleIdentifier,
	SUBVENUE_LEGS,
	type SubVenueLeg,
} from "./sub-venue.ts"

const lexicon = readSubVenueLexicon(defaultLexiconPath())
const shippedModifiers = lexicon.modifiers.filter((m) => m.shipped).map((m) => m.id)
const legFor = (locale: string): SubVenueLeg => SUBVENUE_LEGS.find((l) => l.locale === locale)!

describe("promotedSurfacesFor", () => {
	it("keeps the shipped English vocabulary for en-GB and adds the ledger's pier", () => {
		const surfaces = promotedSurfacesFor("en-GB", lexicon).map((s) => s.phrase)

		expect(surfaces).toContain("wing")
		expect(surfaces).toContain("terminal")
		expect(surfaces).toContain("concourse")
		expect(surfaces).toContain("pier")
		// 0 real of 3,273 in the GB extract — 3,204 of them bus stops named after a village hall.
		expect(surfaces).not.toContain("hall")
	})

	it("drops wing for en-US — Red Wing boots and chicken wings are 3,354 of 3,358", () => {
		const surfaces = promotedSurfacesFor("en-US", lexicon).map((s) => s.phrase)

		expect(surfaces).not.toContain("wing")
		expect(surfaces).not.toContain("pier")
		expect(surfaces).not.toContain("hall")
		// The rest of the shipped list is untouched by the US board.
		expect(surfaces).toContain("terminal")
		expect(surfaces).toContain("concourse")
		expect(surfaces).toContain("gate")
	})

	it("promotes the localized fr-FR surfaces and refuses porte", () => {
		const surfaces = promotedSurfacesFor("fr-FR", lexicon).map((s) => s.phrase)

		expect(surfaces).toContain("hall")
		expect(surfaces).toContain("terminal")
		// 894 of 946 hits are Paris city gates and their Métro stations, and shape cannot separate them.
		expect(surfaces).not.toContain("porte")
		expect(surfaces).not.toContain("wing")
	})

	it("carries de-DE halle as identifier-required and never modifier-eligible", () => {
		const surfaces = promotedSurfacesFor("de-DE", lexicon)
		const halle = surfaces.find((s) => s.phrase === "halle")

		expect(halle).toBeDefined()
		expect(halle!.identifierRequired).toBe(true)
		expect(halle!.modifierEligible).toBe(false)
		expect(surfaces.map((s) => s.phrase)).toContain("flugsteig")
	})

	it("gives a non-English locale no English shipped surfaces", () => {
		// The shipped list is English; es-ES gets exactly what its board earned.
		expect(promotedSurfacesFor("es-ES", lexicon).map((s) => s.phrase)).toEqual(["terminal"])
	})

	it("covers every promote decision in the ledger except the ja-JP one this shard excludes", () => {
		const promoted = SUBVENUE_PROMOTIONS.filter((p) => p.decision === "promote")

		const covered = new Set(
			SUBVENUE_LEGS.flatMap((leg) => promotedSurfacesFor(leg.locale, lexicon).map((s) => `${leg.locale}|${s.phrase}`))
		)

		const missing = promoted.filter((p) => !covered.has(`${p.locale}|${p.phrase}`))

		expect(missing.map((p) => `${p.locale}|${p.phrase}`)).toEqual(["ja-JP|ターミナル"])
	})
})

describe("matchesPromotedShape", () => {
	const halle = promotedSurfacesFor("de-DE", lexicon).find((s) => s.phrase === "halle")!

	it("accepts an identifier-bearing German hall and refuses the city", () => {
		expect(matchesPromotedShape("messe west halle 8", halle)).toBe(true)
		expect(matchesPromotedShape("vw halle 42", halle)).toBe(true)
		expect(matchesPromotedShape("halle", halle)).toBe(false)
	})

	it("refuses a German hall whose follower is a WORD, not an identifier", () => {
		// The 2026-08-05 smoke put `Halle Wohnstadt Nord` in the attested pool under a looser rule.
		// `Wohnstadt` is a name; the de-DE board turns on an IDENTIFIER following the phrase.
		expect(matchesPromotedShape("halle wohnstadt nord", halle)).toBe(false)
		expect(matchesPromotedShape("halle rosengarten", halle)).toBe(false)
		expect(matchesPromotedShape("halle-südstadt", halle)).toBe(false)
	})

	it("refuses a whole venue's name that merely contains a promoted designator", () => {
		const terminal = promotedSurfacesFor("en-GB", lexicon).find((s) => s.phrase === "terminal")!
		const campus = promotedSurfacesFor("en-GB", lexicon).find((s) => s.phrase === "campus")!

		expect(matchesPromotedShape("terminal 2 d", terminal, shippedModifiers, true)).toBe(true)
		expect(matchesPromotedShape("terminal de ferry de bilbao", terminal, shippedModifiers, true)).toBe(false)
		expect(matchesPromotedShape("glasgow clyde college - langside campus", campus, shippedModifiers, true)).toBe(false)
		expect(matchesPromotedShape("kings meadow campus", campus, shippedModifiers, true)).toBe(false)
	})

	it("refuses a follower that is a short WORD rather than an identifier", () => {
		const gate = promotedSurfacesFor("en-GB", lexicon).find((s) => s.phrase === "gate")!
		const terminal = promotedSurfacesFor("en-GB", lexicon).find((s) => s.phrase === "terminal")!

		// `Inn`, `de` and `East` all clear a 1–4-character test and all classify as `other`.
		expect(matchesPromotedShape("the gate inn", gate, shippedModifiers, true)).toBe(false)
		expect(matchesPromotedShape("humberstone gate east", gate, shippedModifiers, true)).toBe(false)
		expect(matchesPromotedShape("terminal de aviación", terminal, shippedModifiers, true)).toBe(false)
		expect(matchesPromotedShape("gate 12", gate, shippedModifiers, true)).toBe(true)
		expect(matchesPromotedShape("terminal 2f", terminal, shippedModifiers, true)).toBe(true)
	})

	it("puts a too-long name that DOES carry the shape in neither pool", () => {
		const terminal = promotedSurfacesFor("fr-FR", lexicon).find((s) => s.phrase === "terminal")!

		expect(hasPromotedShape("navette n2 vers terminal 2g", terminal)).toBe(true)
		expect(matchesPromotedShape("navette n2 vers terminal 2g", terminal)).toBe(false)
	})

	it("accepts an attested modifier+designator only on an English leg", () => {
		const wing = promotedSurfacesFor("en-GB", lexicon).find((s) => s.phrase === "wing")!

		expect(matchesPromotedShape("west wing", wing, shippedModifiers, true)).toBe(true)
		expect(matchesPromotedShape("west wing", wing, shippedModifiers, false)).toBe(false)
	})
})

describe("isSignIdentifier", () => {
	it("accepts what a sign carries and refuses a network code", () => {
		for (const value of ["5", "12", "205", "B", "A12", "B05", "2F", "4S", "16-18", "0/1", "A5/A6"]) {
			expect([value, isSignIdentifier(value)]).toEqual([value, true])
		}

		// Multi-letter prefixes are campus / platform / stop codes, not identifiers — `AG1` is a
		// Sheffield bus stop on a street called Arundel Gate.
		for (const value of ["AG1", "AG124", "BS04", "PWP2", "WSW3687", "RQ8", "CHU", "Inn", "de"]) {
			expect([value, isSignIdentifier(value)]).toEqual([value, false])
		}
	})
})

describe("containsPhrase", () => {
	it("respects word boundaries — a Yorkshire street is not a gate", () => {
		expect(containsPhrase("briggate", "gate")).toBe(false)
		expect(containsPhrase("kirkgate", "gate")).toBe(false)
		expect(containsPhrase("wingate", "wing")).toBe(false)
		expect(containsPhrase("gate 12", "gate")).toBe(true)
		expect(containsPhrase("dockyard main gate", "gate")).toBe(true)
	})
})

describe("sampleIdentifier", () => {
	it("samples Great Britain's bare-digit majority for a GB gate", () => {
		const model = buildIdentifierModel(lexicon, "GB")
		const random = makeMulberry32(7)
		let digits = 0

		for (let i = 0; i < 2000; i++) {
			if (/^[0-9]+$/.test(sampleIdentifier(model, "gate", random)!)) {
				digits++
			}
		}

		// The lexicon measures 463 of 655 GB gate refs as bare digits (71%).
		expect(digits / 2000).toBeGreaterThan(0.6)
		expect(digits / 2000).toBeLessThan(0.82)
	})

	it("samples Spain's range shape, which no other region produces at that rate", () => {
		const model = buildIdentifierModel(lexicon, "ES")
		const random = makeMulberry32(7)
		let ranges = 0

		for (let i = 0; i < 2000; i++) {
			if (/[-/]/.test(sampleIdentifier(model, "gate", random)!)) {
				ranges++
			}
		}

		// 174 of 493 ES gate refs are ranges (B18-B20, D42-D43).
		expect(ranges / 2000).toBeGreaterThan(0.2)
	})

	it("gives Britain and Spain measurably different distributions for the same designator", () => {
		const gb = buildIdentifierModel(lexicon, "GB")
		const es = buildIdentifierModel(lexicon, "ES")

		const share = (model: ReturnType<typeof buildIdentifierModel>): number => {
			const random = makeMulberry32(11)
			let digits = 0

			for (let i = 0; i < 2000; i++) {
				if (/^[0-9]+$/.test(sampleIdentifier(model, "gate", random)!)) {
					digits++
				}
			}

			return digits / 2000
		}

		expect(share(gb) - share(es)).toBeGreaterThan(0.3)
	})

	it("falls back to the region's pooled distribution for a designator with no refs of its own", () => {
		const model = buildIdentifierModel(lexicon, "FR")

		// `concourse` has zero identifierShapes rows in any region; the FR pool still answers.
		expect(sampleIdentifier(model, "concourse", makeMulberry32(3))).toBeTruthy()
	})
})

describe("buildPositiveForms", () => {
	it("never emits a bare or modified Halle for de-DE", () => {
		const leg = legFor("de-DE")
		const promoted = promotedSurfacesFor("de-DE", lexicon)
		const model = buildIdentifierModel(lexicon, "DE")
		const random = makeMulberry32(42)
		let halleRows = 0

		for (let i = 0; i < 4000; i++) {
			const form = buildSubVenueForm(leg, promoted, model, shippedModifiers, [], random)

			if (!form) continue

			expect(form.form).not.toBe("modifier-designator")

			if (/halle/i.test(form.text)) {
				halleRows++
				// Every Halle carries an identifier after it, and nothing before it.
				expect(form.text).toMatch(/^Halle\s+\S+$/)
			}
		}

		expect(halleRows).toBeGreaterThan(0)
	})

	it("produces the target modifier+designator class for an English leg, and never for a non-English one", () => {
		const model = buildIdentifierModel(lexicon, "GB")
		const english = legFor("en-GB")
		const french = legFor("fr-FR")

		const drawForms = (leg: SubVenueLeg, locale: string, region: string): string[] => {
			const random = makeMulberry32(5)
			const promoted = promotedSurfacesFor(locale, lexicon)
			const identifiers = buildIdentifierModel(lexicon, region)
			const out: string[] = []

			for (let i = 0; i < 1500; i++) {
				const form = buildSubVenueForm(leg, promoted, identifiers, shippedModifiers, [], random)

				if (form) {
					out.push(form.form)
				}
			}

			return out
		}

		const gb = drawForms(english, "en-GB", "GB")
		const fr = drawForms(french, "fr-FR", "FR")

		expect(gb.filter((f) => f === "modifier-designator").length / gb.length).toBeGreaterThan(0.4)
		expect(fr.filter((f) => f === "modifier-designator")).toHaveLength(0)
		expect(model).toBeDefined()
	})

	it("never puts a modifier in front of a designator the shipped list excludes", () => {
		const leg = legFor("en-GB")
		const promoted = promotedSurfacesFor("en-GB", lexicon)
		const model = buildIdentifierModel(lexicon, "GB")
		const random = makeMulberry32(9)

		for (let i = 0; i < 4000; i++) {
			const form = buildSubVenueForm(leg, promoted, model, shippedModifiers, [], random)

			if (form?.form !== "modifier-designator") continue
			// "East Gate" and "Building Society Place" are streets — `gate` and `building` are not
			// modifier-eligible, and neither is the newly-promoted `pier`.
			expect(form.designatorID).not.toBe("gate")
			expect(form.designatorID).not.toBe("building")
			expect(form.designatorID).not.toBe("pier")
		}
	})

	it("uses an attested string when one is offered, at roughly the seasoning dose", () => {
		const leg = legFor("en-GB")
		const promoted = promotedSurfacesFor("en-GB", lexicon)
		const model = buildIdentifierModel(lexicon, "GB")
		const random = makeMulberry32(13)
		let attested = 0

		for (let i = 0; i < 2000; i++) {
			if (
				buildSubVenueForm(leg, promoted, model, shippedModifiers, ["Pier 1", "Terminal 2"], random)?.form === "attested"
			) {
				attested++
			}
		}

		expect(attested / 2000).toBeGreaterThan(0.05)
		expect(attested / 2000).toBeLessThan(0.16)
	})
})

describe("isBoardReserved", () => {
	it("drops every surface the 30-row confound board owns", () => {
		expect(isBoardReserved("Wing Yip, 375 Nechells Park Road, Birmingham, B7 5NT")).toBe(true)
		expect(isBoardReserved("12 Briggate, Leeds, LS1 6ER")).toBe(true)
		expect(isBoardReserved("Gate House, 1 Farringdon Street")).toBe(true)
		expect(isBoardReserved("12 East Gate, Warwick")).toBe(true)
		// A different -gate street of the same class is exactly what the shard is allowed to teach.
		expect(isBoardReserved("14 Stonegate, York")).toBe(false)
	})
})

describe("buildStreetNegatives", () => {
	const designatorPhrases = lexicon.designators.filter((d) => d.tier === "subvenue").map((d) => d.id)

	it("separates the three street confound classes", () => {
		const context = [
			{ street: "Pier Road", locality: "Gravesend", postcode: "DA11 0BQ", house_number: "3" },
			{ street: "North Gate", locality: "Newark", postcode: "NG24 1HD", house_number: "8" },
			{ street: "Stonegate", locality: "York", postcode: "YO1 8AS", house_number: "14" },
			{ street: "Windmill View", locality: "Biggleswade", postcode: "SG18 8WP", house_number: "4" },
		]

		const negatives = buildStreetNegatives(context, designatorPhrases, shippedModifiers, "GB")

		expect(negatives.designator.map((t) => t.street)).toEqual(["Pier Road"])
		expect(negatives.modifierDesignator.map((t) => t.street)).toEqual(["North Gate"])
		expect(negatives.gateSuffix.map((t) => t.street)).toEqual(["Stonegate"])
	})
})

describe("allocate", () => {
	it("splits a total across shares that do not sum to one, exactly", () => {
		const parts = allocate(
			1000,
			SUBVENUE_LEGS.map((l) => l.positiveShare)
		)

		expect(parts.reduce((a, b) => a + b, 0)).toBe(1000)
		expect(parts.every((p) => p >= 0)).toBe(true)
	})

	it("returns zeros when every share is zero", () => {
		expect(allocate(100, [0, 0])).toEqual([0, 0])
	})
})
