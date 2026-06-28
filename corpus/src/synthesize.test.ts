/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { BIO_LABELS, type ComponentTag } from "@mailwoman/core/types"
import { describe, expect, it } from "vitest"

import { alignRow } from "./align.js"
import {
	AUGMENTATIONS,
	accentStrip,
	caseLower,
	caseUpper,
	composeAdversarialRow,
	defaultAugmentationsForCountry,
	directionalAbbreviate,
	directionalExpand,
	doubleSpace,
	dropCommas,
	particleStrip,
	stateAbbreviate,
	stateExpand,
	streetSuffixAbbreviate,
	streetSuffixExpand,
	synthesizeRow,
	typoInject,
	unitDesignatorAbbreviate,
	unitDesignatorExpand,
	zipPlus4DashDrop,
} from "./synthesize.js"
import type { CanonicalRow, LabeledRow } from "./types.js"

const baseRow = (over: Partial<CanonicalRow>): CanonicalRow => ({
	raw: "",
	components: {},
	country: "US",
	source: "test",
	source_id: "t-1",
	corpus_version: "0.1.0",
	license: "CC0-1.0",
	...over,
})

describe("universal augmentations", () => {
	it("caseUpper transforms raw + components, sets synth marker", () => {
		const out = caseUpper(
			baseRow({ raw: "Portland, OR 97214", components: { locality: "Portland", region: "OR", postcode: "97214" } })
		)!
		expect(out.raw).toBe("PORTLAND, OR 97214")
		expect(out.components.locality).toBe("PORTLAND")
		expect(out.synth?.method).toBe("case-upper")
		expect(out.synth?.base_source_id).toBe("t-1")
		expect(out.source_id).toBe("t-1+case-upper")
	})

	it("caseUpper returns null on already-upper input", () => {
		const out = caseUpper(baseRow({ raw: "PARIS", components: { locality: "PARIS" } }))
		expect(out).toBeNull()
	})

	it("caseLower flips Paris → paris", () => {
		const out = caseLower(baseRow({ raw: "Paris", components: { locality: "Paris" } }))!
		expect(out.raw).toBe("paris")
		expect(out.components.locality).toBe("paris")
	})

	it("dropCommas strips commas + collapses spaces", () => {
		const out = dropCommas(
			baseRow({ raw: "Portland, OR 97214", components: { locality: "Portland", region: "OR", postcode: "97214" } })
		)!
		expect(out.raw).toBe("Portland OR 97214")
		expect(out.synth?.method).toBe("drop-commas")
	})

	it("doubleSpace inserts double spaces in raw AND in components (alignment-safe)", () => {
		const out = doubleSpace(
			baseRow({
				raw: "Champs Élysées, Paris, France",
				components: { street: "Champs Élysées", locality: "Paris", country: "France" },
			})
		)!
		expect(out.raw).toBe("Champs  Élysées,  Paris,  France")
		// Components must double-space too: alignment substring-searches each component in raw,
		// so single-spaced "Champs Élysées" would not appear in the double-spaced raw.
		expect(out.components.street).toBe("Champs  Élysées")
		expect(out.components.locality).toBe("Paris")
		expect(out.components.country).toBe("France")

		// Substring invariant: every component value must appear in raw.
		for (const v of Object.values(out.components)) {
			if (v) expect(out.raw.includes(v)).toBe(true)
		}
	})

	it("accentStrip flips Hôtel → Hotel, Île-de-France → Ile-de-France", () => {
		const out = accentStrip(
			baseRow({
				raw: "Paris, Île-de-France, France",
				country: "FR",
				components: { locality: "Paris", region: "Île-de-France", country: "France" },
			})
		)!
		expect(out.raw).toBe("Paris, Ile-de-France, France")
		expect(out.components.region).toBe("Ile-de-France")
	})

	it("accentStrip returns null when no accents present", () => {
		const out = accentStrip(baseRow({ raw: "Paris", components: { locality: "Paris" } }))
		expect(out).toBeNull()
	})
})

describe("US augmentations", () => {
	it("stateExpand OR → Oregon", () => {
		const out = stateExpand(
			baseRow({
				raw: "Portland, OR 97214",
				components: { locality: "Portland", region: "OR", postcode: "97214" },
			})
		)!
		expect(out.raw).toBe("Portland, Oregon 97214")
		expect(out.components.region).toBe("Oregon")
		expect(out.synth?.method).toBe("state-expand")
	})

	it("stateAbbreviate Oregon → OR", () => {
		const out = stateAbbreviate(
			baseRow({
				raw: "Portland, Oregon",
				components: { locality: "Portland", region: "Oregon" },
			})
		)!
		expect(out.raw).toBe("Portland, OR")
		expect(out.components.region).toBe("OR")
	})

	it("stateExpand only fires for US country", () => {
		const out = stateExpand(baseRow({ raw: "Paris OR", country: "FR", components: { region: "OR" } }))
		expect(out).toBeNull()
	})

	it("directionalExpand NW → Northwest in street_suffix", () => {
		const out = directionalExpand(
			baseRow({
				raw: "1600 Pennsylvania Ave NW",
				components: { house_number: "1600", street: "Pennsylvania", street_suffix: "Ave NW" },
			})
		)!
		expect(out.raw).toBe("1600 Pennsylvania Ave Northwest")
		expect(out.components.street_suffix).toBe("Ave Northwest")
	})

	it("directionalAbbreviate Southeast → SE in street", () => {
		const out = directionalAbbreviate(
			baseRow({
				raw: "6220 Salmon St Southeast",
				components: { house_number: "6220", street: "Salmon St Southeast" },
			})
		)!
		expect(out.raw).toBe("6220 Salmon St SE")
	})

	it("zipPlus4DashDrop 12345-6789 → 123456789", () => {
		const out = zipPlus4DashDrop(
			baseRow({
				raw: "Portland, OR 12345-6789",
				components: { locality: "Portland", region: "OR", postcode: "12345-6789" },
			})
		)!
		expect(out.components.postcode).toBe("123456789")
		expect(out.raw).toBe("Portland, OR 123456789")
	})

	it("zipPlus4DashDrop returns null for non-ZIP+4 postcodes", () => {
		const out = zipPlus4DashDrop(baseRow({ components: { postcode: "97214" } }))
		expect(out).toBeNull()
	})
})

describe("US street-suffix codex augmentations (Pub-28 Appendix C)", () => {
	it("streetSuffixAbbreviate Avenue → Ave (title case preserved)", () => {
		const out = streetSuffixAbbreviate(
			baseRow({
				raw: "350 5th Avenue, New York, NY 10118",
				components: {
					house_number: "350",
					street: "5th Avenue",
					locality: "New York",
					region: "NY",
					postcode: "10118",
				},
			})
		)!
		expect(out.components.street).toBe("5th Ave")
		expect(out.raw).toBe("350 5th Ave, New York, NY 10118")
		expect(out.synth?.method).toBe("us-street-suffix-abbreviate")
	})

	it("streetSuffixAbbreviate AVENUE → AVE (uppercase preserved, OpenAddresses-style)", () => {
		const out = streetSuffixAbbreviate(
			baseRow({
				raw: "350 5TH AVENUE, NEW YORK, NY 10118",
				components: {
					house_number: "350",
					street: "5TH AVENUE",
					locality: "NEW YORK",
					region: "NY",
					postcode: "10118",
				},
			})
		)!
		expect(out.components.street).toBe("5TH AVE")
		expect(out.raw).toContain("5TH AVE,")
	})

	it("streetSuffixAbbreviate Street → St", () => {
		const out = streetSuffixAbbreviate(
			baseRow({
				raw: "100 Main Street, Anytown, US",
				components: { house_number: "100", street: "Main Street", locality: "Anytown" },
			})
		)!
		expect(out.components.street).toBe("Main St")
		expect(out.raw).toContain("Main St,")
	})

	it("streetSuffixAbbreviate Boulevard → Blvd", () => {
		const out = streetSuffixAbbreviate(
			baseRow({
				raw: "1 Sunset Boulevard",
				components: { house_number: "1", street: "Sunset Boulevard" },
			})
		)!
		expect(out.components.street).toBe("Sunset Blvd")
	})

	it("streetSuffixAbbreviate returns null when trailing word is already the preferred abbreviation", () => {
		const out = streetSuffixAbbreviate(
			baseRow({
				raw: "100 Main St",
				components: { house_number: "100", street: "Main St" },
			})
		)
		expect(out).toBeNull()
	})

	it("streetSuffixAbbreviate accepts non-preferred variants and rewrites them to preferred (AV → AVE)", () => {
		const out = streetSuffixAbbreviate(
			baseRow({
				raw: "100 MAIN AV",
				components: { house_number: "100", street: "MAIN AV" },
			})
		)!
		expect(out.components.street).toBe("MAIN AVE")
	})

	it("streetSuffixAbbreviate returns null when no trailing USPS suffix is recognized", () => {
		const out = streetSuffixAbbreviate(
			baseRow({
				raw: "100 Broadway",
				components: { house_number: "100", street: "Broadway" },
			})
		)
		expect(out).toBeNull()
	})

	it("streetSuffixAbbreviate only fires for US country", () => {
		const out = streetSuffixAbbreviate(baseRow({ country: "FR", components: { street: "Avenue Foch" } }))
		expect(out).toBeNull()
	})

	it("streetSuffixExpand Ave → Avenue (title case preserved)", () => {
		const out = streetSuffixExpand(
			baseRow({
				raw: "350 5th Ave, New York, NY 10118",
				components: { house_number: "350", street: "5th Ave", locality: "New York", region: "NY", postcode: "10118" },
			})
		)!
		expect(out.components.street).toBe("5th Avenue")
		expect(out.raw).toBe("350 5th Avenue, New York, NY 10118")
		expect(out.synth?.method).toBe("us-street-suffix-expand")
	})

	it("streetSuffixExpand AVE → AVENUE (uppercase preserved)", () => {
		const out = streetSuffixExpand(
			baseRow({
				raw: "350 5TH AVE",
				components: { house_number: "350", street: "5TH AVE" },
			})
		)!
		expect(out.components.street).toBe("5TH AVENUE")
	})

	it("streetSuffixExpand handles non-preferred variants (AV → AVENUE, STRT → STREET)", () => {
		const av = streetSuffixExpand(baseRow({ raw: "1 MAIN AV", components: { house_number: "1", street: "MAIN AV" } }))!
		expect(av.components.street).toBe("MAIN AVENUE")

		const strt = streetSuffixExpand(
			baseRow({ raw: "1 MAIN STRT", components: { house_number: "1", street: "MAIN STRT" } })
		)!
		expect(strt.components.street).toBe("MAIN STREET")
	})

	it("streetSuffixExpand returns null when trailing word is already the canonical full form", () => {
		const out = streetSuffixExpand(
			baseRow({
				raw: "1 Sunset Boulevard",
				components: { house_number: "1", street: "Sunset Boulevard" },
			})
		)
		expect(out).toBeNull()
	})

	it("AUGMENTATIONS includes us-street-suffix-abbreviate + us-street-suffix-expand", () => {
		expect(AUGMENTATIONS["us-street-suffix-abbreviate"]).toBe(streetSuffixAbbreviate)
		expect(AUGMENTATIONS["us-street-suffix-expand"]).toBe(streetSuffixExpand)
	})

	it("defaultAugmentationsForCountry('US') includes both suffix augmentations", () => {
		const us = defaultAugmentationsForCountry("US")
		expect(us).toContain(streetSuffixAbbreviate)
		expect(us).toContain(streetSuffixExpand)
	})
})

describe("US unit-designator codex augmentations (Pub-28 Appendix C2)", () => {
	const unitRow = (over: Partial<CanonicalRow>): CanonicalRow =>
		baseRow({
			raw: "123 Main St Apt 4B, Oakland, CA 94601",
			components: {
				house_number: "123",
				street: "Main St",
				unit: "Apt 4B",
				locality: "Oakland",
				region: "CA",
				postcode: "94601",
			},
			...over,
		})

	it("unitDesignatorExpand Apt → Apartment (title case + identifier preserved)", () => {
		const out = unitDesignatorExpand(unitRow({}))!
		expect(out.components.unit).toBe("Apartment 4B")
		expect(out.raw).toBe("123 Main St Apartment 4B, Oakland, CA 94601")
		expect(out.synth?.method).toBe("us-unit-designator-expand")
	})

	it("unitDesignatorAbbreviate Apartment → Apt", () => {
		const out = unitDesignatorAbbreviate(
			unitRow({
				raw: "123 Main St Apartment 4B, Oakland, CA 94601",
				components: {
					house_number: "123",
					street: "Main St",
					unit: "Apartment 4B",
					locality: "Oakland",
					region: "CA",
					postcode: "94601",
				},
			})
		)!
		expect(out.components.unit).toBe("Apt 4B")
		expect(out.raw).toContain("Main St Apt 4B,")
	})

	it("unitDesignatorAbbreviate SUITE → STE (uppercase preserved)", () => {
		const out = unitDesignatorAbbreviate(
			unitRow({ raw: "1 OCEAN DR SUITE 200", components: { house_number: "1", street: "OCEAN DR", unit: "SUITE 200" } })
		)!
		expect(out.components.unit).toBe("STE 200")
		expect(out.raw).toContain("STE 200")
	})

	it("unitDesignatorExpand handles a designator-only unit (Basement → Bsmt inverse)", () => {
		const out = unitDesignatorExpand(
			unitRow({ raw: "12 Elm St Bsmt", components: { house_number: "12", street: "Elm St", unit: "Bsmt" } })
		)!
		expect(out.components.unit).toBe("Basement")
		expect(out.raw).toContain("Elm St Basement")
	})

	it("unitDesignatorAbbreviate returns null when the designator is already the approved abbreviation", () => {
		expect(unitDesignatorAbbreviate(unitRow({}))).toBeNull() // "Apt 4B" already abbreviated
	})

	it("returns null when the unit has no recognized leading designator (bare identifier)", () => {
		const row = unitRow({
			raw: "123 Main St 4B, Oakland, CA 94601",
			components: {
				house_number: "123",
				street: "Main St",
				unit: "4B",
				locality: "Oakland",
				region: "CA",
				postcode: "94601",
			},
		})
		expect(unitDesignatorExpand(row)).toBeNull()
		expect(unitDesignatorAbbreviate(row)).toBeNull()
	})

	it("returns null on a non-US row + when there's no unit component", () => {
		expect(unitDesignatorExpand(unitRow({ country: "FR" }))).toBeNull()
		expect(
			unitDesignatorExpand(baseRow({ raw: "123 Main St", components: { house_number: "123", street: "Main St" } }))
		).toBeNull()
	})

	it("AUGMENTATIONS + defaultAugmentationsForCountry('US') include both unit augmentations", () => {
		expect(AUGMENTATIONS["us-unit-designator-abbreviate"]).toBe(unitDesignatorAbbreviate)
		expect(AUGMENTATIONS["us-unit-designator-expand"]).toBe(unitDesignatorExpand)
		const us = defaultAugmentationsForCountry("US")
		expect(us).toContain(unitDesignatorAbbreviate)
		expect(us).toContain(unitDesignatorExpand)
	})
})

describe("FR augmentations", () => {
	it("particleStrip removes 'de la' from raw and drops particle component", () => {
		const out = particleStrip(
			baseRow({
				raw: "10 Rue de la République, 75008 Paris",
				country: "FR",
				components: {
					house_number: "10",
					street_prefix: "Rue",
					street_prefix_particle: "de la",
					street: "République",
					locality: "Paris",
					postcode: "75008",
				},
			})
		)!
		expect(out.raw).toBe("10 Rue République, 75008 Paris")
		expect(out.components.street_prefix_particle).toBeUndefined()
		expect(out.components.street_prefix).toBe("Rue")
		expect(out.synth?.method).toBe("particle-strip")
	})

	it("particleStrip returns null when no particle is present", () => {
		const out = particleStrip(baseRow({ country: "FR", components: { street: "République" } }))
		expect(out).toBeNull()
	})

	it("particleStrip skips US rows", () => {
		const out = particleStrip(baseRow({ country: "US", components: { street_prefix_particle: "de la" } }))
		expect(out).toBeNull()
	})
})

describe("registry + defaults", () => {
	it("AUGMENTATIONS maps every public augmentation by stable id", () => {
		expect(AUGMENTATIONS["case-upper"]).toBe(caseUpper)
		expect(AUGMENTATIONS["accent-strip"]).toBe(accentStrip)
		expect(AUGMENTATIONS["state-expand"]).toBe(stateExpand)
	})

	it("defaultAugmentationsForCountry: US includes state-expand, FR includes accent-strip", () => {
		const us = defaultAugmentationsForCountry("US")
		const fr = defaultAugmentationsForCountry("FR")
		expect(us).toContain(stateExpand)
		expect(us).toContain(stateAbbreviate)
		expect(fr).toContain(accentStrip)
		expect(fr).toContain(particleStrip)
		expect(us).not.toContain(particleStrip)
		expect(fr).not.toContain(stateExpand)
	})

	it("synthesizeRow yields non-null transforms across the default policy", () => {
		const row = baseRow({
			raw: "Portland, OR 97214",
			components: { locality: "Portland", region: "OR", postcode: "97214" },
		})
		const out = Array.from(synthesizeRow(row))
		// Case-upper + case-lower + drop-commas + double-space + state-expand all apply
		const methods = out.map((r) => r.synth?.method)
		expect(methods).toContain("case-upper")
		expect(methods).toContain("case-lower")
		expect(methods).toContain("drop-commas")
		expect(methods).toContain("double-space")
		expect(methods).toContain("state-expand")
	})

	it("source_id of an augmented row chains under its base", () => {
		const row = baseRow({
			raw: "Portland, Oregon",
			components: { locality: "Portland", region: "Oregon" },
		})
		const out = Array.from(synthesizeRow(row))
		const upper = out.find((r) => r.synth?.method === "case-upper")!
		expect(upper.source_id).toBe("t-1+case-upper")
		expect(upper.synth?.base_source_id).toBe("t-1")
	})
})

// ===========================================================================
// Raw-surface punctuation survival (#519 / PR #534 open question 3)
// ===========================================================================
//
// Every augmentation transforms `raw` by direct string splicing (replace/case-map on the raw
// itself — never a rebuild from a token list), and the build pipeline re-runs `alignRow` on each
// augmented copy, deriving the char-offset span triple from the AUGMENTED raw. These probes pin
// the property v0.5.0 makes essential: intra-span punctuation (the dotted `P.O. Box` is the
// canonical case) survives onto the augmented copy, and every span addresses the new raw exactly.
// A future refactor that rebuilds raw from tokens would fail these.

describe("augmented copies keep intra-span punctuation (#519)", () => {
	/** Apply the augmentation, align the copy, and return the labeled row (asserting both steps). */
	const augmentAndAlign = (id: string, row: CanonicalRow) => {
		const out = AUGMENTATIONS[id]!(row)
		expect(out, `${id} should apply to its fixture`).not.toBeNull()
		const aligned = alignRow(out!)
		expect(aligned.kind, `${id} copy should align (got ${JSON.stringify(aligned.row)})`).toBe("labeled")

		if (aligned.kind !== "labeled") throw new Error("unreachable")
		// Every span must address the augmented raw exactly: its slice IS the component surface.
		const { raw, span_starts, span_ends, span_tags } = aligned.row

		for (let i = 0; i < span_tags!.length; i++) {
			expect(raw.slice(span_starts![i]!, span_ends![i]!)).toBe(out!.components[span_tags![i]!])
		}

		return aligned.row
	}

	/** The dotted po_box surface on the augmented copy — slice the span, not the tokens. */
	const poBoxSurface = (row: LabeledRow): string => {
		const i = row.span_tags!.indexOf("po_box")
		expect(i).toBeGreaterThanOrEqual(0)

		return row.raw.slice(row.span_starts![i]!, row.span_ends![i]!)
	}

	const poBoxRow = (over: Partial<CanonicalRow> = {}): CanonicalRow =>
		baseRow({
			raw: "P.O. Box 5, Portland, OR 97214",
			components: { po_box: "P.O. Box 5", locality: "Portland", region: "OR", postcode: "97214" },
			...over,
		})

	const streetRow = (street: string): CanonicalRow =>
		baseRow({
			raw: `P.O. Box 5, 100 ${street}, Portland, OR 97214`,
			components: {
				po_box: "P.O. Box 5",
				house_number: "100",
				street,
				locality: "Portland",
				region: "OR",
				postcode: "97214",
			},
		})

	const unitRow = (unit: string): CanonicalRow =>
		baseRow({
			raw: `P.O. Box 5, 123 Main St ${unit}, Portland, OR 97214`,
			components: {
				po_box: "P.O. Box 5",
				house_number: "123",
				street: "Main St",
				unit,
				locality: "Portland",
				region: "OR",
				postcode: "97214",
			},
		})

	const cases: ReadonlyArray<[id: string, row: CanonicalRow, expectedPoBox: string]> = [
		["case-upper", poBoxRow(), "P.O. BOX 5"],
		["case-lower", poBoxRow(), "p.o. box 5"],
		// drop-commas deliberately deletes the commas BETWEEN spans; the dots inside the span stay.
		["drop-commas", poBoxRow(), "P.O. Box 5"],
		["double-space", poBoxRow(), "P.O.  Box  5"],
		// typo-inject edits the locality ("Portland"); the po_box span (digits → never eligible) survives.
		["typo-inject", poBoxRow(), "P.O. Box 5"],
		[
			"accent-strip",
			poBoxRow({
				raw: "P.O. Box 5, Mâcon 97214",
				components: { po_box: "P.O. Box 5", locality: "Mâcon", postcode: "97214" },
			}),
			"P.O. Box 5",
		],
		["state-expand", poBoxRow(), "P.O. Box 5"],
		[
			"state-abbreviate",
			poBoxRow({
				raw: "P.O. Box 5, Portland, Oregon 97214",
				components: { po_box: "P.O. Box 5", locality: "Portland", region: "Oregon", postcode: "97214" },
			}),
			"P.O. Box 5",
		],
		["directional-expand", streetRow("Main St NW"), "P.O. Box 5"],
		["directional-abbreviate", streetRow("Main St Northwest"), "P.O. Box 5"],
		["us-street-suffix-abbreviate", streetRow("Main Street"), "P.O. Box 5"],
		["us-street-suffix-expand", streetRow("Main St"), "P.O. Box 5"],
		["us-unit-designator-abbreviate", unitRow("Apartment 4B"), "P.O. Box 5"],
		["us-unit-designator-expand", unitRow("Apt 4B"), "P.O. Box 5"],
		[
			"zip-plus4-dash-drop",
			poBoxRow({
				raw: "P.O. Box 5, Portland, OR 97214-1234",
				components: { po_box: "P.O. Box 5", locality: "Portland", region: "OR", postcode: "97214-1234" },
			}),
			"P.O. Box 5",
		],
		[
			"particle-strip",
			baseRow({
				raw: "B.P. 24, 10 Rue de la République, 75008 Paris",
				country: "FR",
				components: {
					po_box: "B.P. 24",
					house_number: "10",
					street_prefix: "Rue",
					street_prefix_particle: "de la",
					street: "République",
					postcode: "75008",
					locality: "Paris",
				},
			}),
			"B.P. 24",
		],
	]

	it.each(cases)("%s: the dotted po_box span survives on the augmented copy", (id, row, expectedPoBox) => {
		const labeled = augmentAndAlign(id, row)
		expect(poBoxSurface(labeled)).toBe(expectedPoBox)
	})

	it("the registry probe table covers every augmentation", () => {
		expect(new Set(cases.map(([id]) => id))).toEqual(new Set(Object.keys(AUGMENTATIONS)))
	})

	it("chained augmentations (case-upper ∘ us-street-suffix-abbreviate) still verify", () => {
		const abbreviated = streetSuffixAbbreviate(streetRow("Main Street"))!
		expect(abbreviated.raw).toBe("P.O. Box 5, 100 Main St, Portland, OR 97214")
		const upper = caseUpper(abbreviated)!
		expect(upper.source_id).toBe("t-1+us-street-suffix-abbreviate+case-upper")
		expect(upper.synth?.base_source_id).toBe("t-1")
		const aligned = alignRow(upper)
		expect(aligned.kind).toBe("labeled")

		if (aligned.kind !== "labeled") return
		const { raw, span_starts, span_ends, span_tags } = aligned.row
		const slice = (tag: ComponentTag) => {
			const i = span_tags!.indexOf(tag)

			return raw.slice(span_starts![i]!, span_ends![i]!)
		}
		expect(slice("po_box")).toBe("P.O. BOX 5")
		expect(slice("street")).toBe("MAIN ST")
	})
})

// ===========================================================================
// composeAdversarialRow (Phase 1.6 §2.1)
// ===========================================================================

describe("composeAdversarialRow", () => {
	it("emits a LabeledRow that round-trips through the BIO label vocabulary", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
		})
		const result = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return
		expect(result.row.tokens.length).toBe(result.row.labels.length)

		for (const label of result.row.labels) {
			expect(BIO_LABELS).toContain(label)
		}
	})

	it("place-name venue: shared 'Buffalo' token stays labeled venue, not locality", () => {
		// Kryptonite case #1 from CONTEXT.md / issue #22.
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
		})
		const result = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		expect(result.row.raw).toBe("Buffalo Health Clinic, Buffalo, NY 14201")
		// The venue prefix: three tokens, all venue-labeled.
		expect(result.row.tokens.slice(0, 3)).toEqual(["Buffalo", "Health", "Clinic"])
		expect(result.row.labels.slice(0, 3)).toEqual(["B-venue", "I-venue", "I-venue"])
		// The address half: the second "Buffalo" must be the locality, NOT venue.
		const buffaloIndices = result.row.tokens.map((t, i) => (t === "Buffalo" ? i : -1)).filter((i) => i >= 0)
		expect(buffaloIndices).toHaveLength(2)
		expect(result.row.labels[buffaloIndices[0]!]).toBe("B-venue")
		expect(result.row.labels[buffaloIndices[1]!]).toBe("B-locality")
	})

	it("place-shaped venue: embedded multi-token place-shaped substring stays venue-labeled", () => {
		// Kryptonite case #2: venue contains a substring that looks like a complete address.
		const address = baseRow({
			raw: "Las Vegas, NV 89109",
			components: { locality: "Las Vegas", region: "NV", postcode: "89109" },
			source_id: "wof-admin-las-vegas",
		})
		const result = composeAdversarialRow("New York, New York Steakhouse", address, {
			pattern: "place-shaped-venue",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		expect(result.row.raw).toBe("New York, New York Steakhouse, Las Vegas, NV 89109")
		// The venue is 5 tokens: New York New York Steakhouse — all venue.
		expect(result.row.tokens.slice(0, 5)).toEqual(["New", "York", "New", "York", "Steakhouse"])
		expect(result.row.labels.slice(0, 5)).toEqual(["B-venue", "I-venue", "I-venue", "I-venue", "I-venue"])
		// The address half: "Las" + "Vegas" → B-locality + I-locality.
		const lasIdx = result.row.tokens.indexOf("Las")
		expect(lasIdx).toBeGreaterThan(0)
		expect(result.row.labels[lasIdx]).toBe("B-locality")
		expect(result.row.labels[lasIdx + 1]).toBe("I-locality")
	})

	it("particle-honorific ambiguity: apostrophe + St. tokens land under venue", () => {
		// Kryptonite case #3: apostrophe + St./Saint ambiguity. "P'tit" and "St." are inside
		// the venue surface form, not a street_prefix or honorific in the address.
		const address = baseRow({
			raw: "Montreal, QC H2X 1Y4",
			country: "CA",
			components: { locality: "Montreal", region: "QC", postcode: "H2X 1Y4" },
			source_id: "test-montreal",
		})
		const result = composeAdversarialRow("P'tit St. Denis Street Café", address, {
			pattern: "particle-honorific",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		// The venue tokens via the whitespace tokenizer: P'tit, St, Denis, Street, Café
		// (period is a separator, apostrophe joins, accented chars are word chars).
		expect(result.row.tokens[0]).toBe("P'tit")
		expect(result.row.tokens[1]).toBe("St")
		// Every venue token gets the venue label — the embedded "St" is venue, not
		// street_prefix.
		const venueTokenCount = 5

		for (let i = 0; i < venueTokenCount; i++) {
			expect(result.row.labels[i]).toBe(i === 0 ? "B-venue" : "I-venue")
		}
	})

	it("address components survive forward onto the composed row as-is", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
		})
		const result = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		expect(result.row.components).toMatchObject({
			venue: "Buffalo Health Clinic",
			locality: "Buffalo",
			region: "NY",
			postcode: "14201",
		})
	})

	it("synth marker carries compose:<pattern> + base_source_id from the address row", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
		})
		const result = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		expect(result.row.synth?.method).toBe("compose:place-name-venue")
		expect(result.row.synth?.base_source_id).toBe("wof-admin-buffalo")
		expect(result.row.source_id).toBe("wof-admin-buffalo+compose:place-name-venue")
	})

	it("preserves country/locale/license/source from the underlying address row", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
			country: "US",
			locale: "en-US",
			source: "wof-admin",
			license: "CC0-1.0",
		})
		const result = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		expect(result.row.country).toBe("US")
		expect(result.row.locale).toBe("en-US")
		expect(result.row.source).toBe("wof-admin")
		expect(result.row.license).toBe("CC0-1.0")
	})

	it("separator option controls the join character", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
		})
		const spaced = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
			separator: " ",
		})
		expect(spaced.kind).toBe("labeled")

		if (spaced.kind === "labeled") expect(spaced.row.raw).toBe("Buffalo Health Clinic Buffalo, NY 14201")

		const newline = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
			separator: "\n",
		})
		expect(newline.kind).toBe("labeled")

		if (newline.kind === "labeled") expect(newline.row.raw).toBe("Buffalo Health Clinic\nBuffalo, NY 14201")
	})

	it("empty venue quarantines with reason=venue-empty", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
		})
		const result = composeAdversarialRow("   ", address, { pattern: "place-name-venue" })
		expect(result.kind).toBe("quarantined")

		if (result.kind === "quarantined") expect(result.row.reason).toBe("venue-empty")
	})

	it("address that fails alignment quarantines with the propagated reason", () => {
		// region "QQQQQQ" can't be located in the raw and is too far from any window to match
		// under default edit distance — alignment quarantines it.
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "QQQQQQ", postcode: "14201" },
		})
		const result = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
		})
		expect(result.kind).toBe("quarantined")

		if (result.kind === "quarantined") {
			expect(result.row.reason).toContain("compose-address-")
			expect(result.row.reason).toContain("region")
		}
	})

	it("re-targets the char-offset span triple onto the composed surface (#519)", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
		})
		const result = composeAdversarialRow("Buffalo Health Clinic", address, {
			pattern: "place-name-venue",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return

		const { raw, span_starts, span_ends, span_tags } = result.row
		expect(raw).toBe("Buffalo Health Clinic, Buffalo, NY 14201")
		// One venue span over the whole venue, then the address spans shifted by venue + separator.
		expect(span_tags).toEqual(["venue", "locality", "region", "postcode"])
		expect(span_starts).toEqual([0, 23, 32, 35])
		expect(span_ends).toEqual([21, 30, 34, 40])
		// Every span reconstructs its component surface verbatim off the COMPOSED raw.
		const surfaces = span_tags!.map((_, i) => raw.slice(span_starts![i]!, span_ends![i]!))
		expect(surfaces).toEqual(["Buffalo Health Clinic", "Buffalo", "NY", "14201"])
		// The separator comma + space sit outside every span (deliberately unlabeled).
		expect(span_ends![0]!).toBeLessThanOrEqual(21)
		expect(span_starts![1]!).toBeGreaterThanOrEqual(23)
	})

	it("composed spans satisfy the #519 invariants under every separator", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
		})

		for (const separator of [", ", " ", "\n"]) {
			const result = composeAdversarialRow("New York, New York Steakhouse", address, {
				pattern: "place-shaped-venue",
				separator,
			})
			expect(result.kind).toBe("labeled")

			if (result.kind !== "labeled") continue
			const { raw, span_starts, span_ends, span_tags } = result.row
			expect(span_starts!.length).toBe(span_ends!.length)
			expect(span_starts!.length).toBe(span_tags!.length)

			for (let i = 0; i < span_starts!.length; i++) {
				expect(span_starts![i]!).toBeGreaterThanOrEqual(0)
				expect(span_starts![i]!).toBeLessThan(span_ends![i]!)
				expect(span_ends![i]!).toBeLessThanOrEqual(raw.length)

				if (i > 0) expect(span_starts![i]!).toBeGreaterThanOrEqual(span_ends![i - 1]!)
			}
		}
	})

	it("venue span covers internal punctuation the token path cannot express", () => {
		const address = baseRow({
			raw: "Montreal, QC H2X 1Y4",
			country: "CA",
			components: { locality: "Montreal", region: "QC", postcode: "H2X 1Y4" },
		})
		const result = composeAdversarialRow("P'tit St. Denis Street Café", address, {
			pattern: "particle-honorific",
		})
		expect(result.kind).toBe("labeled")

		if (result.kind !== "labeled") return
		// The whole venue — apostrophe, period, accent included — is ONE span.
		expect(result.row.span_tags![0]).toBe("venue")
		expect(result.row.raw.slice(result.row.span_starts![0]!, result.row.span_ends![0]!)).toBe(
			"P'tit St. Denis Street Café"
		)
	})

	it("non-NFC venue quarantines with reason=venue-not-nfc (offset ambiguity guard)", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
		})
		const nfdVenue = "Café Olé".normalize("NFD")
		const result = composeAdversarialRow(nfdVenue, address, { pattern: "place-name-venue" })
		expect(result.kind).toBe("quarantined")

		if (result.kind === "quarantined") expect(result.row.reason).toBe("venue-not-nfc")
	})

	it("is deterministic: two compositions of the same inputs produce identical output", () => {
		const address = baseRow({
			raw: "Buffalo, NY 14201",
			components: { locality: "Buffalo", region: "NY", postcode: "14201" },
			source_id: "wof-admin-buffalo",
		})
		const a = composeAdversarialRow("Buffalo Health Clinic", address, { pattern: "place-name-venue" })
		const b = composeAdversarialRow("Buffalo Health Clinic", address, { pattern: "place-name-venue" })
		expect(a).toEqual(b)
	})
})

describe("typoInject (#530)", () => {
	const row = baseRow({
		raw: "123 Cupertino Avenue, Cupertino, CA 95014",
		components: {
			house_number: "123",
			street: "Cupertino Avenue",
			locality: "Cupertino",
			region: "CA",
			postcode: "95014",
		},
		source_id: "typo-fixture",
	})

	it("injects exactly one typo into an alpha-name component, applied to raw + the component", () => {
		const out = typoInject(row)
		expect(out).not.toBeNull()
		expect(out!.synth?.method).toBe("typo-inject")
		const changed = (Object.keys(row.components) as ComponentTag[]).filter(
			(k) => row.components[k] !== out!.components[k]
		)
		expect(changed).toHaveLength(1)
		const tag = changed[0]!
		expect(tag).not.toBe("house_number")
		expect(tag).not.toBe("postcode")
		// substring contract: the typo'd value is present in the new raw
		expect(out!.raw).toContain(out!.components[tag]!)
		// changed, and same length (a transpose or a single-char substitution)
		expect(out!.components[tag]).not.toBe(row.components[tag])
		expect(out!.components[tag]!.length).toBe(row.components[tag]!.length)
	})

	it("is deterministic — the same source_id yields the same typo (reproducible corpus)", () => {
		expect(typoInject(row)).toEqual(typoInject(row))
	})

	it("never touches digit components — number + postcode survive verbatim", () => {
		const out = typoInject(row)!
		expect(out.components.house_number).toBe("123")
		expect(out.components.postcode).toBe("95014")
	})

	it("returns null when there is no eligible alpha component", () => {
		const out = typoInject(
			baseRow({ raw: "123 95014", components: { house_number: "123", postcode: "95014" }, source_id: "n" })
		)
		expect(out).toBeNull()
	})

	it("the augmented row still aligns — every span addresses raw exactly (end-to-end substring contract)", () => {
		const out = typoInject(row)!
		const aligned = alignRow(out)
		expect(aligned.kind, `typo'd row should align (got ${JSON.stringify(aligned.row)})`).toBe("labeled")

		if (aligned.kind !== "labeled") throw new Error("unreachable")
		const { raw, span_starts, span_ends, span_tags } = aligned.row

		for (let i = 0; i < span_tags!.length; i++) {
			expect(raw.slice(span_starts![i]!, span_ends![i]!)).toBe(out.components[span_tags![i]!])
		}
	})
})
