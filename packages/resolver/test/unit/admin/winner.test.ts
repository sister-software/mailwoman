/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The two shapes of one ordering must agree.
 *
 *   Result assembly walks a TAG ladder; the eval harnesses sort resolved nodes by PLACETYPE. Both are expressing the
 *   same claim about where a postcode sits, and #1773 is what it cost when they drifted: each harness froze one arm of
 *   a conditional as a constant, so every grader was right on one half of the data and wrong on the other,
 *   unconditionally. The binding assertions below are the ones a constant cannot satisfy.
 */

import { AREA_POSTCODE_FINER_THAN_LOCALITY } from "@mailwoman/codex"
import type { AddressNode } from "@mailwoman/core/decoder"
import { PLACETYPE_FILTER_GROUPS } from "@mailwoman/core/resolver"
import { PLACETYPE_SPECIFICITY } from "@mailwoman/core/resources/whosonfirst/specificity"
import {
	ADMIN_LADDER_LOCALITY_FIRST,
	ADMIN_LADDER_POSTCODE_FIRST,
	adminLadderFor,
	adminLadderForNodes,
	AREA_GRADE_POSTALCODE_SPECIFICITY,
	mostSpecificResolved,
	resolvedSpecificity,
} from "@mailwoman/resolver/admin"
import { describe, expect, it } from "vitest"

/**
 * A GB unit postcode the resolver answered with the FULL code — the #22 case.
 */
const GB_UNIT = { value: "N7 0BT", resolverName: "n70bt" }
/**
 * The same span, coarsened by the resolver to the outward district — AREA-class.
 */
const GB_OUTWARD = { value: "N7 0BT", resolverName: "n7" }
/**
 * A US ZIP: a full code, and never unit-grade whatever the resolver returns.
 */
const US_ZIP = { value: "62701", resolverName: "62701" }
/**
 * An NL PC6.
 */
const NL_PC6 = { value: "1012 LG", resolverName: "1012LG" }
/**
 * A German PLZ: an ordinary 5-digit code, unit-grade by no shape test, whose SYSTEM earns the lead.
 */
const DE_PLZ = { value: "12623", resolverName: "12623" }

const rank = (placetype: string, hit?: { value: string; resolverName: string; country?: string }): number =>
	resolvedSpecificity({
		placetype,
		...(hit
			? { value: hit.value, resolverName: hit.resolverName, ...(hit.country ? { country: hit.country } : {}) }
			: {}),
	})

const leads = (ladder: ReadonlyArray<string>, a: string, b: string): boolean => ladder.indexOf(a) < ladder.indexOf(b)

describe("adminLadderFor", () => {
	it("leads with the postcode only on a unit-grade exact hit", () => {
		expect(adminLadderFor(GB_UNIT)).toBe(ADMIN_LADDER_POSTCODE_FIRST)
		expect(adminLadderFor(NL_PC6)).toBe(ADMIN_LADDER_POSTCODE_FIRST)
		expect(adminLadderFor(GB_OUTWARD)).toBe(ADMIN_LADDER_LOCALITY_FIRST)
		expect(adminLadderFor(US_ZIP)).toBe(ADMIN_LADDER_LOCALITY_FIRST)
		expect(adminLadderFor(undefined)).toBe(ADMIN_LADDER_LOCALITY_FIRST)
	})

	it("carries the same rungs on both arms", () => {
		expect([...ADMIN_LADDER_POSTCODE_FIRST].toSorted()).toEqual([...ADMIN_LADDER_LOCALITY_FIRST].toSorted())
	})

	it("ranks a JP municipality above its district on both arms — an unscoped district picks namesakes", () => {
		for (const ladder of [ADMIN_LADDER_POSTCODE_FIRST, ADMIN_LADDER_LOCALITY_FIRST]) {
			expect(ladder.indexOf("locality")).toBeLessThan(ladder.indexOf("municipality"))
			expect(ladder.indexOf("municipality")).toBeLessThan(ladder.indexOf("district"))
			expect(ladder.indexOf("district")).toBeLessThan(ladder.indexOf("region"))
			expect(ladder.indexOf("region")).toBeLessThan(ladder.indexOf("prefecture"))
			expect(ladder.indexOf("prefecture")).toBeLessThan(ladder.indexOf("country"))
		}
	})

	// #1780. The second route to postcode-first: the CODE is ordinary, the address SYSTEM is not.
	it("leads with an area-grade postcode for a country whose codes outrank its localities", () => {
		expect(adminLadderFor({ ...DE_PLZ, country: "DE" })).toBe(ADMIN_LADDER_POSTCODE_FIRST)
		expect(adminLadderFor({ ...DE_PLZ, country: "de" })).toBe(ADMIN_LADDER_POSTCODE_FIRST)
	})

	it("leaves every other country on the locality-first default", () => {
		for (const country of ["FR", "IT", "ES", "US", "GB", "NL", "AU", "CA", "JP", ""]) {
			expect(adminLadderFor({ ...DE_PLZ, country })).toBe(ADMIN_LADDER_LOCALITY_FIRST)
		}

		expect(adminLadderFor({ ...DE_PLZ, country: undefined })).toBe(ADMIN_LADDER_LOCALITY_FIRST)
		expect(adminLadderFor(DE_PLZ)).toBe(ADMIN_LADDER_LOCALITY_FIRST)
	})

	// The membership table is a MEASURED claim, so a silent addition is the thing to catch — a new entry has to arrive
	// with its panel, the way DE did.
	it("holds exactly the countries a full-panel measurement has admitted", () => {
		expect([...AREA_POSTCODE_FINER_THAN_LOCALITY].toSorted()).toEqual(["DE"])
	})
})

describe("adminLadderForNodes", () => {
	const pcNode = (
		value: string,
		resolverName: string,
		over: { country?: string; lat?: number; lon?: number } = {}
	): AddressNode => ({
		tag: "postcode",
		value,
		start: 0,
		end: value.length,
		confidence: 1,
		children: [],
		metadata: { resolver_name: resolverName, ...(over.country ? { resolver_country: over.country } : {}) },
		...(over.lat === undefined ? {} : { lat: over.lat, lon: over.lon }),
	})

	it("finds the postcode node and reads both routes off it", () => {
		expect(adminLadderForNodes([pcNode("N7 0BT", "n70bt", { lat: 51.55, lon: -0.13 })])).toBe(
			ADMIN_LADDER_POSTCODE_FIRST
		)

		expect(adminLadderForNodes([pcNode("12623", "12623", { country: "DE", lat: 52.5, lon: 13.5 })])).toBe(
			ADMIN_LADDER_POSTCODE_FIRST
		)

		expect(adminLadderForNodes([pcNode("62701", "62701", { country: "US", lat: 39.8, lon: -89.6 })])).toBe(
			ADMIN_LADDER_LOCALITY_FIRST
		)
	})

	it("ignores a postcode node with no coordinate — the ladder picks among placed nodes", () => {
		expect(adminLadderForNodes([pcNode("12623", "12623", { country: "DE" })])).toBe(ADMIN_LADDER_LOCALITY_FIRST)
	})

	it("falls back to locality-first when no postcode node is present", () => {
		expect(adminLadderForNodes([])).toBe(ADMIN_LADDER_LOCALITY_FIRST)
	})
})

describe("resolvedSpecificity", () => {
	it("ranks a unit-grade postcode above every locality tier", () => {
		expect(rank("postalcode", GB_UNIT)).toBeGreaterThan(rank("locality"))
		expect(rank("postalcode", NL_PC6)).toBeGreaterThan(rank("locality"))
	})

	// The tier is the resolver's own `locality` GROUP, not the `locality` placetype: a New England civil town resolves
	// as `localadmin`, and ranking a ZIP above it puts the postcode point back on exactly those rows.
	it("ranks an AREA-grade postcode below every member of the locality tier", () => {
		const tier = PLACETYPE_FILTER_GROUPS["locality"] ?? []

		expect(tier.length).toBeGreaterThan(1)

		for (const hit of [US_ZIP, GB_OUTWARD]) {
			for (const placetype of tier) {
				expect(rank("postalcode", hit)).toBeLessThan(rank(placetype))
			}
		}
	})

	it("ranks an AREA-grade postcode above the county tiers and region", () => {
		for (const hit of [US_ZIP, GB_OUTWARD]) {
			for (const placetype of [...(PLACETYPE_FILTER_GROUPS["county"] ?? []), "region", "country"]) {
				expect(rank("postalcode", hit)).toBeGreaterThan(rank(placetype))
			}
		}
	})

	it("leaves every other placetype on the shared scale", () => {
		for (const [placetype, specificity] of Object.entries(PLACETYPE_SPECIFICITY)) {
			if (placetype === "postalcode") continue

			expect(rank(placetype)).toBe(specificity)
		}
	})

	it("sorts an unranked placetype below everything, including planet", () => {
		expect(rank("wormhole")).toBe(Number.NEGATIVE_INFINITY)
		expect(rank("wormhole")).toBeLessThan(rank("planet"))
	})

	it("treats a postcode with no parsed span as area-grade", () => {
		expect(resolvedSpecificity({ placetype: "postalcode" })).toBe(AREA_GRADE_POSTALCODE_SPECIFICITY)
	})
})

describe("the ladder and the scale agree", () => {
	// The binding assertion. A grader that froze one arm passes each half in isolation and fails here.
	it("orders postcode against locality the same way, on both arms", () => {
		for (const hit of [
			GB_UNIT,
			NL_PC6,
			US_ZIP,
			GB_OUTWARD,
			{ ...DE_PLZ, country: "DE" },
			{ ...DE_PLZ, country: "FR" },
			DE_PLZ,
		]) {
			const ladderLeadsWithPostcode = leads(adminLadderFor(hit), "postcode", "locality")
			const scaleLeadsWithPostcode = rank("postalcode", hit) > rank("locality")

			expect(scaleLeadsWithPostcode).toBe(ladderLeadsWithPostcode)
		}
	})

	it("orders postcode against region the same way, on both arms", () => {
		for (const hit of [GB_UNIT, US_ZIP]) {
			expect(rank("postalcode", hit) > rank("region")).toBe(leads(adminLadderFor(hit), "postcode", "region"))
		}
	})
})

describe("mostSpecificResolved", () => {
	const place = (placetype: string, value = "", resolverName = "") => ({ placetype, value, resolverName })

	const pick = <T extends { placetype: string; value: string; resolverName: string }>(candidates: T[]) =>
		mostSpecificResolved(candidates, (c) => ({
			placetype: c.placetype,
			value: c.value,
			resolverName: c.resolverName,
		}))

	it("returns null on an empty set", () => {
		expect(pick([])).toBeNull()
	})

	it("prefers the locality over an area-grade postcode", () => {
		const locality = place("locality")
		expect(pick([place("postalcode", US_ZIP.value, US_ZIP.resolverName), locality])).toBe(locality)
	})

	it("prefers a unit-grade postcode over the locality", () => {
		const postcode = place("postalcode", GB_UNIT.value, GB_UNIT.resolverName)
		expect(pick([place("locality"), postcode])).toBe(postcode)
	})

	it("keeps the first of a tie, which is document order", () => {
		const first = place("locality")
		expect(pick([first, place("locality")])).toBe(first)
	})

	it("returns the candidate object itself, not a projection", () => {
		const only = { ...place("locality"), id: 42 }
		expect(pick([only])).toBe(only)
	})
})
