/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classifications, ClassificationsMatchMap, isVisibleClassification } from "@mailwoman/core/types"
import { expect, test } from "vitest"

// A classification that is valid but NOT in the visible set — derived through the public API so the
// test doesn't couple to the (unexported) VisibleClassification set's contents.
const PRIVATE_CLASSIFICATION = [...Classifications].find((c) => !isVisibleClassification(c))!

test("isVisibleClassification: visible vs private, string and match forms", () => {
	expect(isVisibleClassification("street")).toBe(true)
	expect(isVisibleClassification("postcode")).toBe(true)
	expect(PRIVATE_CLASSIFICATION).toBeDefined()
	expect(isVisibleClassification(PRIVATE_CLASSIFICATION)).toBe(false)

	// match form: the predicate reads `.classification` off the match object
	expect(isVisibleClassification({ classification: "street", confidence: 1 })).toBe(true)
	expect(isVisibleClassification({ classification: PRIVATE_CLASSIFICATION, confidence: 1 })).toBe(false)
})

test("ClassificationsMatchMap.add stores a match with the given confidence", () => {
	const map = new ClassificationsMatchMap()
	map.add("street", 0.7)

	expect(map.has("street")).toBe(true)
	expect(map.get("street")!.classification).toBe("street")
	expect(map.get("street")!.confidence).toBe(0.7)
})

test("ClassificationsMatchMap.add defaults confidence to a valid [0,1] value when omitted", () => {
	const map = new ClassificationsMatchMap()
	map.add("street")

	const conf = map.get("street")!.confidence
	expect(typeof conf).toBe("number")
	expect(conf).toBeGreaterThan(0)
	expect(conf).toBeLessThanOrEqual(1)
})

test("ClassificationsMatchMap.add keeps the higher-confidence match (never reduces)", () => {
	const map = new ClassificationsMatchMap()
	map.add("street", 0.5)

	// a lower (or equal) confidence is ignored…
	map.add("street", 0.3)
	expect(map.get("street")!.confidence).toBe(0.5)
	map.add("street", 0.5)
	expect(map.get("street")!.confidence).toBe(0.5)

	// …a strictly higher confidence replaces it
	map.add("street", 0.9)
	expect(map.get("street")!.confidence).toBe(0.9)
})

test("ClassificationsMatchMap.add rejects out-of-range confidence", () => {
	const map = new ClassificationsMatchMap()
	expect(() => map.add("street", 1.5)).toThrow(RangeError)
	expect(() => map.add("street", -0.1)).toThrow(RangeError)
	expect(map.size).toBe(0)
})

test("ClassificationsMatchMap.hasVisibleClassification", () => {
	const map = new ClassificationsMatchMap()
	expect(map.hasVisibleClassification()).toBe(false)

	map.add(PRIVATE_CLASSIFICATION, 0.9)
	// a private classification does not count as a visible one
	expect(map.hasVisibleClassification()).toBe(false)

	map.add("locality", 0.8)
	expect(map.hasVisibleClassification()).toBe(true)
	// the optional argument is a direct membership check
	expect(map.hasVisibleClassification("locality")).toBe(true)
	expect(map.hasVisibleClassification("region")).toBe(false)
})
