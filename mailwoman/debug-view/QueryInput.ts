/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The debug view's query field: a controlled single-line text input with readline's editing keys.
 *
 *   It replaces `ink-text-input`, which mis-handles the whole modified-key family. Measured through a pty against Ink
 *   7.1.1 + ink-text-input 6.0.0 (`input.pty.test.ts` is the regression):
 *
 *   - **Ctrl+W (`\x17`)** — what a terminal sends for "delete the word before the cursor", and what iTerm2 sends for
 *     ⌥⌫ by default — reaches `useInput` as `input: "w"` with `key.ctrl` set, because Ink resolves ctrl+letter to the
 *     LETTER. `ink-text-input`'s handler guards only ctrl+C, so every other ctrl chord falls through to its insert
 *     branch and types the letter: holding alt and pressing backspace appended a `w`.
 *   - **Meta+backspace (`\x1b\x7f`)** arrives correctly flagged (`key.backspace` + `key.meta`, empty input) and is
 *     then treated as a plain backspace — one character, not one word.
 *
 *   Both are the same defect: the modifier is delivered and ignored. So the rule here is inverted — an unhandled
 *   ctrl/meta chord is DROPPED, never inserted. A control byte can only ever reach the value as an edit.
 *
 *   JSX-free on purpose (`.ts`, `createElement`): bare node strips types but does not transform JSX, so this is the
 *   form that lets the pty probe run the REAL component from source, the way `map-tui`'s pty test runs its real bin.
 *   The component is one `<Text>` — the JSX would have bought nothing.
 */

import { Text, useInput, type Key } from "ink"
import { createElement, type ReactElement } from "react"

//#region Editing model

export interface InputState {
	value: string
	/**
	 * UTF-16 offset the cursor sits BEFORE, in `[0, value.length]`, and never INSIDE a surrogate pair — every move and
	 * every delete in this module steps by whole codepoints, so `value.slice(cursor)` is always a valid string. (Ink
	 * measures and slices in UTF-16 too; keeping the offset in the same units as the render is what makes the two agree.
	 * See {@link stepLeft}.)
	 */
	cursor: number
}

/**
 * The UTF-16 offset one CODEPOINT left of `index`.
 *
 * `codePointAt(index - 2)` returns a value above the BMP only when `index - 2` genuinely starts a surrogate pair, so
 * this steps 2 across `🏠` and 1 across everything else. Stepping by one unit instead is how a backspace after an emoji
 * leaves a lone surrogate in the query — a string that renders as `�` and that the tokenizer never saw in training.
 */
function stepLeft(value: string, index: number): number {
	if (index <= 0) return 0

	const previous = value.codePointAt(index - 2)

	return previous != null && previous > 0xff_ff ? index - 2 : index - 1
}

/**
 * The UTF-16 offset one CODEPOINT right of `index`.
 */
function stepRight(value: string, index: number): number {
	if (index >= value.length) return value.length

	const current = value.codePointAt(index)

	return current != null && current > 0xff_ff ? index + 2 : index + 1
}

/**
 * Bound an offset to the value AND out of the middle of a surrogate pair — the only place a caller-supplied cursor can
 * be illegal.
 */
function clampCursor(value: string, index: number): number {
	const bounded = Math.max(0, Math.min(index, value.length))
	const unit = value.charCodeAt(bounded)

	// A low surrogate at the cursor means the offset landed inside a pair; the codepoint starts one unit back.
	return unit >= 0xdc_00 && unit <= 0xdf_ff ? bounded - 1 : bounded
}

/**
 * What survives from a typed or PASTED run: CR/LF/tab runs collapse to one space, other control characters are dropped,
 * and everything else is kept.
 *
 * Collapsing rather than rejecting is the point. Pasting a multi-line address into a one-line field is a thing people
 * do constantly, and refusing the whole paste because it contains a newline drops the address on the floor with no
 * feedback — the field just doesn't respond. `12 Rue de Rivoli\n75001 Paris` becomes the query it obviously means.
 */
function printableRun(input: string): string {
	return input.replaceAll(/[\r\n\t]+/gu, " ").replaceAll(/\p{Cc}/gu, "")
}

/**
 * Start of the word before `cursor`, whitespace-delimited: skip the whitespace immediately behind the cursor, then the
 * run of non-whitespace behind that.
 *
 * Whitespace-delimited (readline's `unix-word-rubout`, the tty's own `werase`) rather than alphanumeric-delimited
 * (`backward-kill-word`), because the text being edited is an address: one press should take `OR`, then `Portland,`,
 * then `St` — not stop inside `Portland` at the comma.
 */
export function wordStart(value: string, cursor: number): number {
	let index = Math.max(0, Math.min(cursor, value.length))

	while (index > 0 && /\s/u.test(value[index - 1]!)) {
		index--
	}

	while (index > 0 && !/\s/u.test(value[index - 1]!)) {
		index--
	}

	return index
}

function deleteRange(state: InputState, start: number, end: number): InputState {
	if (start >= end) return state

	return { value: state.value.slice(0, start) + state.value.slice(end), cursor: start }
}

/**
 * Apply one keypress to the field, or return the state UNCHANGED when the key isn't the field's business.
 *
 * Pure, and exported for its own tests: the pty proves the bytes arrive as this function expects, and the unit tests
 * prove the edits are right, without either having to do the other's job.
 */
export function applyKey(state: InputState, input: string, key: Key): InputState {
	const { value } = state
	const cursor = clampCursor(value, state.cursor)

	if (key.leftArrow) return { value, cursor: stepLeft(value, cursor) }

	if (key.rightArrow) return { value, cursor: stepRight(value, cursor) }

	if (key.home) return { value, cursor: 0 }

	if (key.end) return { value, cursor: value.length }

	// Ink names the two deletes apart, and so does the keyboard: `backspace` is the key above Enter (`\x7f`),
	// `delete` is the FORWARD Delete of the navigation cluster (`ESC[3~`). Folding them together made the Delete
	// key eat the character behind the cursor, which is the opposite of what it says on it.
	if (key.backspace) {
		const start = key.meta ? wordStart(value, cursor) : stepLeft(value, cursor)

		return deleteRange({ value, cursor }, start, cursor)
	}

	if (key.delete) {
		return deleteRange({ value, cursor }, cursor, stepRight(value, cursor))
	}

	if (key.ctrl) {
		// The readline set, spelled out. Every one of these arrives as a bare letter (Ink resolves ctrl+letter to
		// the letter), so anything NOT listed has to fall through to the drop below — inserting it is the bug.
		switch (input) {
			case "w":
				return deleteRange({ value, cursor }, wordStart(value, cursor), cursor)
			case "u":
				return deleteRange({ value, cursor }, 0, cursor)
			case "k":
				return deleteRange({ value, cursor }, cursor, value.length)
			case "a":
				return { value, cursor: 0 }
			case "e":
				return { value, cursor: value.length }
			default:
				return state
		}
	}

	// An unhandled meta chord (alt+f, alt+b, …) is DROPPED, and so is anything with no printable content left —
	// `input` is empty for the keys Ink names (arrows, escape, tab).
	if (key.meta) return state

	const insert = printableRun(input)

	if (!insert.length) return state

	return {
		value: value.slice(0, cursor) + insert + value.slice(cursor),
		cursor: cursor + insert.length,
	}
}

//#endregion

//#region Component

export interface QueryInputProps {
	value: string
	cursor: number
	/**
	 * Called with the next state on every edit — the field is fully controlled, so the parent owns both halves.
	 */
	onChange: (next: InputState) => void
	onSubmit: (value: string) => void
	/**
	 * Inactive fields neither consume keys nor draw a cursor.
	 */
	focus: boolean
}

/**
 * The cursor cell when it sits past the last character.
 */
const CURSOR_PAD = " "

export function QueryInput(props: QueryInputProps): ReactElement {
	const { value, cursor, focus, onChange, onSubmit } = props

	useInput(
		(input, key) => {
			if (key.return) {
				onSubmit(value)

				return
			}

			// Tab (focus) and escape (quit) belong to the session's own handler; consuming them here would make the
			// field a trap the user cannot leave.
			if (key.tab || key.escape) return

			const next = applyKey({ value, cursor }, input, key)

			if (next.value !== value || next.cursor !== cursor) {
				onChange(next)
			}
		},
		{ isActive: focus }
	)

	if (!focus) return createElement(Text, { wrap: "truncate-end" }, value)

	// The inverted cell is a whole CODEPOINT, not a UTF-16 unit: `slice(cursor, cursor + 1)` over `🏠` inverts half a
	// surrogate pair and paints `�` under the cursor.
	const safeCursor = clampCursor(value, cursor)
	const point = value.codePointAt(safeCursor)
	const under = point == null ? CURSOR_PAD : String.fromCodePoint(point)

	return createElement(
		Text,
		{ wrap: "truncate-end" },
		value.slice(0, safeCursor),
		createElement(Text, { inverse: true }, under),
		value.slice(safeCursor + (point == null ? 0 : under.length))
	)
}

//#endregion
