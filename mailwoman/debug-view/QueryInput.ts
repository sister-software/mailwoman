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
	 * Character index the cursor sits BEFORE, in `[0, value.length]`.
	 */
	cursor: number
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
	if (key.leftArrow) return { ...state, cursor: Math.max(0, state.cursor - 1) }

	if (key.rightArrow) return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) }

	if (key.home) return { ...state, cursor: 0 }

	if (key.end) return { ...state, cursor: state.value.length }

	if (key.backspace || key.delete) {
		// Meta+backspace is the word-delete the terminal is asking for; a bare backspace is one character.
		const start = key.meta ? wordStart(state.value, state.cursor) : state.cursor - 1

		return deleteRange(state, Math.max(0, start), state.cursor)
	}

	if (key.ctrl) {
		// The readline set, spelled out. Every one of these arrives as a bare letter (Ink resolves ctrl+letter to
		// the letter), so anything NOT listed has to fall through to the drop below — inserting it is the bug.
		switch (input) {
			case "w":
				return deleteRange(state, wordStart(state.value, state.cursor), state.cursor)
			case "u":
				return deleteRange(state, 0, state.cursor)
			case "k":
				return deleteRange(state, state.cursor, state.value.length)
			case "a":
				return { ...state, cursor: 0 }
			case "e":
				return { ...state, cursor: state.value.length }
			default:
				return state
		}
	}

	// An unhandled meta chord (alt+f, alt+b, …) and every non-printable sequence Ink hands through are DROPPED.
	// `input` is empty for the keys Ink names (arrows, escape, tab); the control-character test catches the rest.
	if (key.meta || !input.length || /[\p{Cc}]/u.test(input)) return state

	return {
		value: state.value.slice(0, state.cursor) + input + state.value.slice(state.cursor),
		cursor: state.cursor + input.length,
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

	const safeCursor = Math.max(0, Math.min(cursor, value.length))
	const under = value.slice(safeCursor, safeCursor + 1) || CURSOR_PAD

	return createElement(
		Text,
		{ wrap: "truncate-end" },
		value.slice(0, safeCursor),
		createElement(Text, { inverse: true }, under),
		value.slice(safeCursor + 1)
	)
}

//#endregion
