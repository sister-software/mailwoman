/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { PYTHON_DECIMAL, pythonIsAlphaCharacter, pythonIsDigit } from "#strings/python-text"

test("a letter Unicode 15.0 assigned is a letter, and one a later version assigned is not", () => {
	expect(pythonIsAlphaCharacter("東")).toBe(true)
	expect(pythonIsAlphaCharacter("é")).toBe(true)
	// CJK Extension I (Unicode 15.1) and Extension J (Unicode 17.0).
	expect(pythonIsAlphaCharacter("\u{2EBF0}")).toBe(false)
	expect(pythonIsAlphaCharacter("\u{323B0}")).toBe(false)
	expect(pythonIsAlphaCharacter("1")).toBe(false)
})

test("Python's \\d matches fullwidth digits and not the digit sets later Unicode versions assigned", () => {
	const decimal = new RegExp(`^${PYTHON_DECIMAL}+$`, "u")

	expect(decimal.test("１１０")).toBe(true)
	expect(decimal.test("110")).toBe(true)
	// Garay digits, Unicode 16.0.
	expect(decimal.test("\u{10D41}")).toBe(false)
	expect(pythonIsDigit("²")).toBe(true)
	expect(pythonIsDigit("\u{10D41}")).toBe(false)
})
