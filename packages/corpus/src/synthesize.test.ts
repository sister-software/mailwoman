/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import {
	AUGMENTATIONS,
	accentStrip,
	caseLower,
	caseUpper,
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
	zipPlus4DashDrop,
} from "./synthesize.js"
import type { CanonicalRow } from "./types.js"

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

	it("doubleSpace inserts double spaces", () => {
		const out = doubleSpace(baseRow({ raw: "Paris France", components: { locality: "Paris", country: "France" } }))!
		expect(out.raw).toBe("Paris  France")
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
