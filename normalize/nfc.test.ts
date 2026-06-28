/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { applyNfc } from "./nfc.js"

// Combining acute accent (U+0301) and the composed forms, by codepoint — so the test's intent
// doesn't depend on how this file's literal characters happen to be normalized on disk.
const COMBINING_ACUTE = "́"
const E_ACUTE = "é" // é (composed, NFC)

test("applyNfc: already-NFC input is a no-op with an identity map", () => {
	const r = applyNfc("Main St")
	expect(r.changed).toBe(false)
	expect(r.text).toBe("Main St")
	expect(r.map).toEqual([0, 1, 2, 3, 4, 5, 6])
})

test("applyNfc: composes a combining accent and maps the composed char to its source", () => {
	// "e" + U+0301 → "é" (U+00E9) — output is one char shorter than the 2-codepoint input.
	const r = applyNfc("e" + COMBINING_ACUTE)
	expect(r.changed).toBe(true)
	expect(r.text).toBe(E_ACUTE)
	expect(r.text).toHaveLength(1)
	// the single output char absorbed input[0] ('e') + input[1] (the combining mark)
	expect(r.map).toEqual([0])
})

test("applyNfc: a mid-word combining mark composes, later chars map past it", () => {
	const r = applyNfc("Cafe" + COMBINING_ACUTE) // → "Caf" + é
	expect(r.changed).toBe(true)
	expect(r.text).toBe("Caf" + E_ACUTE)
	expect(r.text).toHaveLength(4)
	// C a f é → source indices 0 1 2 3 (é at out[3] came from input[3], absorbing the mark at input[4])
	expect(r.map).toEqual([0, 1, 2, 3])
})

test("applyNfc: empty input", () => {
	expect(applyNfc("")).toEqual({ text: "", map: [], changed: false })
})
