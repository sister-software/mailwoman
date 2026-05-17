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
