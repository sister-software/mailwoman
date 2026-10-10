/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { buildCodexSpanLexicon } from "#span"
import { VENUE_STRUCTURE_DESIGNATORS } from "#venue/structure"

test("buildCodexSpanLexicon: assembles the four designator sets + a delivery-service regex", () => {
	const lex = buildCodexSpanLexicon(["us"])
	expect(lex.systems).toEqual(new Set(["us"]))
	expect(lex.unitDesignators.size).toBeGreaterThan(0)

	// every entry is lower-cased (the proposer matches case-folded)
	for (const d of lex.unitDesignators) {
		expect(d).toBe(d.toLowerCase())
	}

	expect(lex.deliveryService).toBeInstanceOf(RegExp)
})

test("buildCodexSpanLexicon: a building LEVEL is categorized apart from a numbered unit", () => {
	const lex = buildCodexSpanLexicon(["us"])
	// floor is a USPS Pub-28 level canonical → goes to levelDesignators rather than unitDesignators.
	expect(lex.levelDesignators.has("floor")).toBe(true)
	expect(lex.unitDesignators.has("floor")).toBe(false)
})

test("buildCodexSpanLexicon: the delivery-service regex matches a PO-box phrase + identifier", () => {
	const re = buildCodexSpanLexicon(["us"]).deliveryService!
	expect(re).toBeInstanceOf(RegExp)
	expect(new RegExp(re.source, "i").test("PO Box 1234")).toBe(true)
	expect(new RegExp(re.source, "i").test("Main Street")).toBe(false)
})

test("buildCodexSpanLexicon: the default loads us+au+nz; the delivery vocabulary grows with systems", () => {
	const all = buildCodexSpanLexicon() // default ["us","au","nz"]
	expect(all.systems).toEqual(new Set(["us", "au", "nz"]))
	// AU/NZ delivery types add alternatives, so the combined pattern is longer than US-only.
	const us = buildCodexSpanLexicon(["us"])
	expect(all.deliveryService!.source.length).toBeGreaterThan(us.deliveryService!.source.length)
})

test("buildCodexSpanLexicon: no systems → only the locale-general venue-structure designators", () => {
	const lex = buildCodexSpanLexicon([])

	expect(lex.systems.size).toBe(0)
	expect(lex.levelDesignators.size).toBe(0)
	expect(lex.deliveryService).toBeUndefined()

	// Every postal designator is system-conditional and therefore absent.
	// That half of the original assertion still holds and is what this test guards:
	// a codex table must never leak in without its system.
	for (const postal of ["apt", "ste", "suite", "rm", "flat", "po box"]) {
		expect(lex.unitDesignators.has(postal), `postal designator "${postal}" leaked with no systems loaded`).toBe(false)
	}

	// What remains is the venue-interior vocabulary.
	// It is deliberately not system-conditional.
	// Postal authority does not change whether a concourse is a concourse.
	// A codex-system key would make "Terminal 5" parse in one country
	// and not another for no defensible reason.
	// Sourced from the WOF placetype vocabulary + OSM aeroway —
	// see core/resources/whosonfirst/placetypes/venue-structure.ts.
	expect([...lex.unitDesignators].toSorted()).toEqual([...VENUE_STRUCTURE_DESIGNATORS].toSorted())
})
