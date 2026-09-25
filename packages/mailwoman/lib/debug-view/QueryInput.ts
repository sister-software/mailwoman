/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Implements the debug view's single-line query field with readline editing keys.
 */

import { Text, useInput, type Key } from "ink"
import { createElement, type ReactElement } from "react"

// #region Editing model

/**
 * Holds the query field's text and cursor.
 */
export interface InputState {
	value: string
	/**
	 * Holds the UTF-16 offset of the cursor, in `[0, value.length]` and never inside a surrogate pair.
	 *
	 * Every move and delete steps by whole codepoints, so `value.slice(cursor)` is always well formed.
	 * Ink also indexes in UTF-16, so the cursor and the render agree.
	 */
	cursor: number
}

/**
 * Returns the UTF-16 offset one codepoint left of `index`.
 *
 * Stepping by one unit would let a backspace after an emoji leave a lone surrogate in the query.
 */
function stepLeft(value: string, index: number): number {
	if (index <= 0) return 0

	const previous = value.codePointAt(index - 2)

	return previous != null && previous > 0xff_ff ? index - 2 : index - 1
}

/**
 * Returns the UTF-16 offset one codepoint right of `index`.
 */
function stepRight(value: string, index: number): number {
	if (index >= value.length) return value.length

	const current = value.codePointAt(index)

	return current != null && current > 0xff_ff ? index + 2 : index + 1
}

/**
 * Clamps a caller-supplied cursor to the value and moves it out of the middle of a surrogate pair.
 */
function clampCursor(value: string, index: number): number {
	const bounded = Math.max(0, Math.min(index, value.length))
	const unit = value.charCodeAt(bounded)

	// A low surrogate at the cursor means the offset landed inside a pair, so the cursor moves back one unit.
	return unit >= 0xdc_00 && unit <= 0xdf_ff ? Math.max(0, bounded - 1) : bounded
}

/**
 * Cleans typed or pasted text for the one-line field.
 *
 * Each run of CR, LF or tab becomes one space, so a pasted multi-line address stays usable.
 * Other control characters are dropped.
 */
function printableRun(input: string): string {
	return input.replaceAll(/[\r\n\t]+/gu, " ").replaceAll(/\p{Cc}/gu, "")
}

/**
 * Returns the start of the whitespace-delimited word before `cursor`.
 *
 * This matches readline's `unix-word-rubout`.
 * Words end at whitespace only, so one delete removes `Portland,` whole instead of stopping at the comma.
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
 * Applies one keypress to the field, or returns the state unchanged when the field does not handle the key.
 *
 * Ink reports ctrl+letter as the bare letter with `key.ctrl` set.
 * An unhandled ctrl or meta chord is therefore dropped, because inserting it
 * would type the letter into the query.
 */
export function applyKey(state: InputState, input: string, key: Key): InputState {
	const { value } = state
	const cursor = clampCursor(value, state.cursor)

	if (key.leftArrow) return { value, cursor: stepLeft(value, cursor) }

	if (key.rightArrow) return { value, cursor: stepRight(value, cursor) }

	if (key.home) return { value, cursor: 0 }

	if (key.end) return { value, cursor: value.length }

	// Backspace (`\x7f`) deletes behind the cursor.
	// Forward Delete (`ESC[3~`) deletes ahead of it.
	if (key.backspace) {
		const start = key.meta ? wordStart(value, cursor) : stepLeft(value, cursor)

		return deleteRange({ value, cursor }, start, cursor)
	}

	if (key.delete) {
		return deleteRange({ value, cursor }, cursor, stepRight(value, cursor))
	}

	if (key.ctrl) {
		// These are the readline bindings.
		// Any other ctrl chord is dropped.
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

	// Unhandled meta chords and input with no printable characters are dropped.
	if (key.meta) return state

	const insert = printableRun(input)

	if (!insert.length) return state

	return {
		value: value.slice(0, cursor) + insert + value.slice(cursor),
		cursor: cursor + insert.length,
	}
}

// #endregion

// #region Component

/**
 * Configures the controlled `QueryInput` field.
 */
export interface QueryInputProps {
	value: string
	cursor: number
	/**
	 * Receives the next value and cursor on every edit.
	 */
	onChange: (next: InputState) => void
	onSubmit: (value: string) => void
	/**
	 * Controls whether the field consumes keys and draws a cursor.
	 */
	focus: boolean
}

/**
 * Fills the cursor cell when the cursor sits past the last character.
 */
const CURSOR_PAD = " "

/**
 * Renders the query field as one Ink `<Text>`.
 *
 * The module avoids JSX so the pty test can run it from source under plain Node,
 * which strips types but does not transform JSX.
 */
export function QueryInput(props: QueryInputProps): ReactElement {
	const { value, cursor, focus, onChange, onSubmit } = props

	useInput(
		(input, key) => {
			if (key.return) {
				onSubmit(value)

				return
			}

			// The session handles tab and escape, which move focus and quit.
			if (key.tab || key.escape) return

			const next = applyKey({ value, cursor }, input, key)

			if (next.value !== value || next.cursor !== cursor) {
				onChange(next)
			}
		},
		{ isActive: focus }
	)

	if (!focus) return createElement(Text, { wrap: "truncate-end" }, value)

	// The inverted cell is a whole codepoint so the cursor never splits a surrogate pair.
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

// #endregion
