/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { buildCodexSpanLexicon } from "./span-proposer-lexicon.js"

test("buildCodexSpanLexicon: assembles the four designator sets + a delivery-service regex", () => {
	const lex = buildCodexSpanLexicon(["us"])
	expect(lex.systems).toEqual(new Set(["us"]))
	expect(lex.unitDesignators.size).toBeGreaterThan(0)
	// every entry is lower-cased (the proposer matches case-folded)
	for (const d of lex.unitDesignators) expect(d).toBe(d.toLowerCase())
	expect(lex.deliveryService).toBeInstanceOf(RegExp)
})

test("buildCodexSpanLexicon: a building LEVEL is categorized apart from a numbered unit", () => {
	const lex = buildCodexSpanLexicon(["us"])
	// FLOOR is a USPS Pub-28 level canonical → goes to levelDesignators, NOT unitDesignators.
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

test("buildCodexSpanLexicon: no systems → empty designators and no delivery-service regex", () => {
	const lex = buildCodexSpanLexicon([])
	expect(lex.systems.size).toBe(0)
	expect(lex.unitDesignators.size).toBe(0)
	expect(lex.levelDesignators.size).toBe(0)
	expect(lex.deliveryService).toBeUndefined()
})
