/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit half of the input-field regression: the edits, given the keys. The other half — that a terminal's
 *   alt+backspace ARRIVES as these keys at all — is `input.pty.test.ts`, and neither test can do the other's job.
 */

import type { Key } from "ink"
import { applyKey, wordStart, type InputState } from "mailwoman/debug-view/QueryInput"
import { describe, expect, it } from "vitest"

/**
 * A `Key` with every flag off but the named ones — Ink hands the handler a fully-populated object, so a partial one
 * would let a branch pass here that a real keypress never reaches.
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
		// The addresses this field edits are full of commas; stopping at one would make ⌥⌫ take half a word.
		expect(wordStart("3215 SE Clinton St, Portland", 28)).toBe(20)
		// A trailing space is skipped first, so this takes `St,` whole — comma included, not stopping before it.
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
		// Ink names the two apart and so does the keyboard: `backspace` is the key above Enter, `delete` is the
		// navigation cluster's forward Delete (ESC[3~). Folding them together made Delete eat the character BEHIND
		// the cursor.
		expect(applyKey({ value: "hello world", cursor: 5 }, "", key({ delete: true }))).toEqual({
			value: "helloworld",
			cursor: 5,
		})

		// At the end of the line it has nothing to take.
		expect(applyKey(AT_END("hello"), "", key({ delete: true }))).toEqual({ value: "hello", cursor: 5 })
	})

	it("deletes the word before the cursor on ctrl+W, which Ink delivers as the letter w", () => {
		// THE BUG: Ink resolves ctrl+letter to `input: "w"` with `key.ctrl`. A handler that only guards ctrl+C
		// falls through to its insert branch and types the letter.
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

		// A paste arrives as one multi-character `input`; the cursor has to advance by its whole length.
		expect(applyKey({ value: "", cursor: 0 }, "3215 SE Clinton St", key())).toEqual({
			value: "3215 SE Clinton St",
			cursor: 18,
		})
	})

	it("steps and deletes by whole codepoints, not UTF-16 units", () => {
		// "St 🏠" is 6 UTF-16 units: the house is a surrogate PAIR. Stepping by one unit leaves a lone surrogate —
		// a string that renders as `�` and that the tokenizer never saw in training.
		const HOUSE = "St 🏠"

		expect(HOUSE).toHaveLength(5)
		expect(applyKey(AT_END(HOUSE), "", key({ backspace: true }))).toEqual({ value: "St ", cursor: 3 })

		// The arrow lands BEFORE the pair, never between its halves.
		expect(applyKey(AT_END(HOUSE), "", key({ leftArrow: true })).cursor).toBe(3)
		expect(applyKey({ value: HOUSE, cursor: 3 }, "", key({ rightArrow: true })).cursor).toBe(5)

		// Forward Delete takes the whole codepoint too.
		expect(applyKey({ value: HOUSE, cursor: 3 }, "", key({ delete: true }))).toEqual({ value: "St ", cursor: 3 })

		// A cursor handed in mid-pair snaps to the pair's START (offset 4 → 3, the way a browser refuses to put a
		// caret inside a grapheme) and the edit applies from there — the space goes, the house survives intact.
		expect(applyKey({ value: HOUSE, cursor: 4 }, "", key({ backspace: true }))).toEqual({
			value: "St🏠",
			cursor: 2,
		})
	})

	it("keeps a pasted multi-line address instead of dropping the whole paste", () => {
		// A paste arrives as ONE `input`. Rejecting it because it contains a newline dropped the address on the
		// floor with no feedback — the field simply didn't respond.
		expect(applyKey({ value: "", cursor: 0 }, "12 Rue de Rivoli\n75001 Paris", key())).toEqual({
			value: "12 Rue de Rivoli 75001 Paris",
			cursor: 28,
		})

		// CRLF collapses to ONE space, and a stray control character inside the run is dropped, not the run.
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
