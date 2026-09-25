/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the query field's edits for given keys. `input.pty.test.ts` tests that a terminal delivers
 *   those keys.
 */

import type { Key } from "ink"
import { applyKey, wordStart, type InputState } from "mailwoman/debug-view/QueryInput"
import { describe, expect, it } from "vitest"

/**
 * Returns a complete `Key` with only the given flags set, matching the full object that Ink passes.
 */
function key(pressed: Partial<Key> = {}): Key {
	return {
		upArrow: false,
		downArrow: false,
		leftArrow: false,
		rightArrow: false,
		pageDown: false,
		pageUp: false,
		home: false,
		end: false,
		return: false,
		escape: false,
		ctrl: false,
		shift: false,
		tab: false,
		backspace: false,
		delete: false,
		meta: false,
		super: false,
		hyper: false,
		capsLock: false,
		numLock: false,
		...pressed,
	} as Key
}

const AT_END = (value: string): InputState => ({ value, cursor: value.length })

describe("wordStart", () => {
	it("skips the whitespace behind the cursor, then the word", () => {
		expect(wordStart("hello world", 11)).toBe(6)
		expect(wordStart("hello world ", 12)).toBe(6)
		expect(wordStart("hello", 5)).toBe(0)
		expect(wordStart("", 0)).toBe(0)
	})

	it("is whitespace-delimited, so punctuation inside a token is not a boundary", () => {
		expect(wordStart("3215 SE Clinton St, Portland", 28)).toBe(20)
		// The trailing space is skipped first, then `St,` is taken with its comma.
		expect(wordStart("3215 SE Clinton St, ", 20)).toBe(16)
	})
})

describe("applyKey", () => {
	it("deletes the word before the cursor on meta+backspace", () => {
		expect(applyKey(AT_END("hello world"), "", key({ backspace: true, meta: true }))).toEqual({
			value: "hello ",
			cursor: 6,
		})
	})

	it("deletes one character on a bare backspace", () => {
		expect(applyKey(AT_END("hello world"), "", key({ backspace: true }))).toEqual({
			value: "hello worl",
			cursor: 10,
		})
	})

	it("forward-deletes on Delete, leaving the cursor where it was", () => {
		// Ink reports forward Delete (ESC[3~) as `delete` and the key above Enter as `backspace`.
		expect(applyKey({ value: "hello world", cursor: 5 }, "", key({ delete: true }))).toEqual({
			value: "helloworld",
			cursor: 5,
		})

		expect(applyKey(AT_END("hello"), "", key({ delete: true }))).toEqual({ value: "hello", cursor: 5 })
	})

	it("deletes the word before the cursor on ctrl+W, which Ink delivers as the letter w", () => {
		// Ink reports ctrl+W as `input: "w"` with `key.ctrl` set.
		expect(applyKey(AT_END("hello world"), "w", key({ ctrl: true }))).toEqual({ value: "hello ", cursor: 6 })
	})

	it("drops every other ctrl chord instead of inserting its letter", () => {
		for (const letter of ["b", "d", "l", "q", "z"]) {
			expect(applyKey(AT_END("hello"), letter, key({ ctrl: true }))).toEqual({ value: "hello", cursor: 5 })
		}
	})

	it("drops meta chords and control characters", () => {
		expect(applyKey(AT_END("hello"), "f", key({ meta: true }))).toEqual({ value: "hello", cursor: 5 })
		expect(applyKey(AT_END("hello"), "\u0000", key())).toEqual({ value: "hello", cursor: 5 })
		expect(applyKey(AT_END("hello"), "", key())).toEqual({ value: "hello", cursor: 5 })
	})

	it("carries the rest of readline's line editing", () => {
		expect(applyKey({ value: "hello world", cursor: 6 }, "u", key({ ctrl: true }))).toEqual({
			value: "world",
			cursor: 0,
		})

		expect(applyKey({ value: "hello world", cursor: 5 }, "k", key({ ctrl: true }))).toEqual({
			value: "hello",
			cursor: 5,
		})

		expect(applyKey(AT_END("hello"), "a", key({ ctrl: true })).cursor).toBe(0)
		expect(applyKey({ value: "hello", cursor: 0 }, "e", key({ ctrl: true })).cursor).toBe(5)
	})

	it("inserts printable text at the cursor, pasted runs included", () => {
		expect(applyKey({ value: "hello world", cursor: 5 }, ",", key())).toEqual({ value: "hello, world", cursor: 6 })

		// A paste arrives as one multi-character `input`, and the cursor advances by its full length.
		expect(applyKey({ value: "", cursor: 0 }, "3215 SE Clinton St", key())).toEqual({
			value: "3215 SE Clinton St",
			cursor: 18,
		})
	})

	it("steps and deletes by whole codepoints, not UTF-16 units", () => {
		// The house emoji is a surrogate pair.
		// Stepping by one UTF-16 unit would leave a lone surrogate.
		const HOUSE = "St 🏠"

		expect(HOUSE).toHaveLength(5)
		expect(applyKey(AT_END(HOUSE), "", key({ backspace: true }))).toEqual({ value: "St ", cursor: 3 })

		expect(applyKey(AT_END(HOUSE), "", key({ leftArrow: true })).cursor).toBe(3)
		expect(applyKey({ value: HOUSE, cursor: 3 }, "", key({ rightArrow: true })).cursor).toBe(5)

		expect(applyKey({ value: HOUSE, cursor: 3 }, "", key({ delete: true }))).toEqual({ value: "St ", cursor: 3 })

		// A cursor inside the pair snaps to the pair's start before the edit applies.
		expect(applyKey({ value: HOUSE, cursor: 4 }, "", key({ backspace: true }))).toEqual({
			value: "St🏠",
			cursor: 2,
		})
	})

	it("keeps a pasted multi-line address instead of dropping the whole paste", () => {
		// Newlines in a paste become spaces.
		expect(applyKey({ value: "", cursor: 0 }, "12 Rue de Rivoli\n75001 Paris", key())).toEqual({
			value: "12 Rue de Rivoli 75001 Paris",
			cursor: 28,
		})

		// CRLF becomes one space, and a control character inside the paste is dropped.
		expect(applyKey({ value: "", cursor: 0 }, "a\r\nb\u0000c", key())).toEqual({ value: "a bc", cursor: 4 })
	})

	it("moves and clamps the cursor", () => {
		expect(applyKey({ value: "abc", cursor: 0 }, "", key({ leftArrow: true })).cursor).toBe(0)
		expect(applyKey({ value: "abc", cursor: 3 }, "", key({ rightArrow: true })).cursor).toBe(3)
		expect(applyKey({ value: "abc", cursor: 1 }, "", key({ home: true })).cursor).toBe(0)
		expect(applyKey({ value: "abc", cursor: 1 }, "", key({ end: true })).cursor).toBe(3)
	})

	it("deletes nothing at the start of the line", () => {
		expect(applyKey({ value: "abc", cursor: 0 }, "", key({ backspace: true }))).toEqual({ value: "abc", cursor: 0 })

		expect(applyKey({ value: "abc", cursor: 0 }, "", key({ backspace: true, meta: true }))).toEqual({
			value: "abc",
			cursor: 0,
		})
	})
})
