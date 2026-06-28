/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { isPOBox, matchPOBox, normalizePOBox } from "./po-box.js"

test("isPOBox: recognizes the USPS designator phrases with an id", () => {
	for (const yes of [
		"PO Box 123",
		"P.O. Box 12-A",
		"Post Office Box 7",
		"po box 5",
		"PO Box #123", // the optional '#'
		"Drawer 5",
		"Lockbox 9",
		"Caller 5",
		"Firm Caller 7",
		"Box 42",
	]) {
		expect(isPOBox(yes)).toBe(true)
	}
})

test("isPOBox: rejects non-PO-box input (incl. a designator with no id)", () => {
	for (const no of ["123 Main St", "PO Box", "Boxford 12", "", "  ", 42, null, undefined]) {
		expect(isPOBox(no)).toBe(false)
	}
})

test("matchPOBox: splits the designator phrase from the id, preserving surface case", () => {
	expect(matchPOBox("PO Box 123")).toEqual({ matched: "PO Box", id: "123" })
	expect(matchPOBox("P.O. Box 12-A")).toEqual({ matched: "P.O. Box", id: "12-A" })
	expect(matchPOBox("Post Office Box 7")).toEqual({ matched: "Post Office Box", id: "7" })
	expect(matchPOBox("Drawer 5")).toEqual({ matched: "Drawer", id: "5" })
	expect(matchPOBox("PO Box #99")).toEqual({ matched: "PO Box", id: "99" }) // '#' consumed, not part of id
	expect(matchPOBox("123 Main St")).toBeNull()
})

test("normalizePOBox: canonicalizes to 'PO BOX <ID>' (id upper-cased); passes through non-PO-box", () => {
	expect(normalizePOBox("p.o. box 12a")).toBe("PO BOX 12A")
	expect(normalizePOBox("Post Office Box 7")).toBe("PO BOX 7")
	expect(normalizePOBox("Box 5")).toBe("PO BOX 5")
	// not a PO box → returned unchanged
	expect(normalizePOBox("123 Main St")).toBe("123 Main St")
})
