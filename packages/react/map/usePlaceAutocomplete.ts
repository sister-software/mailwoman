/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usePlaceAutocomplete` — the headless "Did you mean" combobox lifted from the demo god component
 *   (`_app.tsx:820-900`). It walks the host-supplied `autocomplete` over the locality segment the visitor
 *   is typing (the text after the last comma), owns the suggestion list + keyboard-highlighted active
 *   descendant, and rewrites the input on pick (replacing just that segment). No FST, no fetch of its own
 *   — the `autocomplete` fetcher is INJECTED (the package never imports `@mailwoman/resolver-wof-sqlite`),
 *   so this stays node-safe and testable with a synchronous fake.
 *
 *   Returns the `<input>` aria/combobox props to spread onto the reused {@link QueryForm} input plus an
 *   `onInputKeyDown` (↑/↓ move the highlight, Enter accepts it AND suppresses submit, Esc dismisses), and
 *   the presentational {@link PlaceAutocomplete} listbox renders `suggestions` / `activeIndex`.
 */

import { type KeyboardEvent, useCallback, useEffect, useState } from "react"

import { useDebouncedValue } from "../common/useDebouncedValue.ts"
import type { Suggestion } from "./types.ts"

export interface UsePlaceAutocompleteOptions {
	/**
	 * The current input text.
	 */
	text: string
	/**
	 * Setter for the input text (a pick rewrites the last-comma segment).
	 */
	setText: (text: string) => void
	/**
	 * The host's autocomplete fetcher (FST prefix-walk). Absent → the combobox is inert.
	 */
	autocomplete?: (query: string) => Promise<Suggestion[]>
	/**
	 * Minimum query length before suggesting. @default 2
	 */
	minChars?: number
	/**
	 * Debounce before firing the fetcher. @default 150
	 */
	debounceMs?: number
}

/**
 * The combobox aria props to spread onto the input the suggestions describe.
 */
export interface AutocompleteInputProps {
	role: "combobox"
	"aria-expanded": boolean
	"aria-controls": string
	"aria-autocomplete": "list"
	"aria-activedescendant": string | undefined
	autoComplete: "off"
}

export interface UsePlaceAutocomplete {
	/**
	 * The current suggestions (empty when nothing matches — the listbox then hides).
	 */
	suggestions: Suggestion[]
	/**
	 * The keyboard-highlighted suggestion index; `-1` when none is highlighted.
	 */
	activeIndex: number
	/**
	 * Set the highlighted index (the listbox calls this on mouse-enter).
	 */
	setActiveIndex: (index: number) => void
	/**
	 * Keydown handler for the input: ↑/↓ highlight, Enter accepts (+ suppresses submit), Esc dismisses.
	 */
	onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
	/**
	 * Accept a suggestion by value (rewrites the last-comma segment, closes the list).
	 */
	pick: (value: string) => void
	/**
	 * Close the list without picking.
	 */
	dismiss: () => void
	/**
	 * Aria/combobox props for the input the suggestions describe.
	 */
	inputProps: AutocompleteInputProps
	/**
	 * The listbox element id (matches `inputProps["aria-controls"]`).
	 */
	listboxID: string
	/**
	 * Build the option element id for suggestion `index`.
	 */
	optionID: (index: number) => string
}

const LISTBOX_ID = "mw-demo-suggest-list"

/**
 * Stable empty list for the derived no-suggestions state — a fresh `[]` per render would churn the identity every
 * consumer and every useCallback dependency list sees.
 */
const NO_SUGGESTIONS: Suggestion[] = []
const optionID = (index: number) => `mw-demo-suggest-${index}`

/**
 * Extract the locality segment being typed — the text after the last comma, trimmed.
 */
function localitySegment(text: string): string {
	return (text.includes(",") ? text.slice(text.lastIndexOf(",") + 1) : text).trim()
}

/**
 * Replace the locality segment (after the last comma) with `name`, preserving the address prefix.
 */
function replaceSegment(current: string, name: string): string {
	return current.includes(",") ? `${current.slice(0, current.lastIndexOf(",") + 1)} ${name}` : name
}

export function usePlaceAutocomplete({
	text,
	setText,
	autocomplete,
	minChars = 2,
	debounceMs = 150,
}: UsePlaceAutocompleteOptions): UsePlaceAutocomplete {
	/**
	 * The last COMPLETED fetch, keyed by the query that produced it. Visibility is DERIVED from this during render rather
	 * than pushed through sync setStates in the effect — the effect's only job is the async fetch, so every state write
	 * in it happens after an await and the react(set-state-in-effect) rule is satisfied by structure, not by exception.
	 */
	const [fetched, setFetched] = useState<{ query: string; suggestions: Suggestion[] } | null>(null)
	/**
	 * The query whose list was dismissed or picked. Suppression as DATA, replacing the one-shot ref flag: a pick stores
	 * the query the rewritten text will produce, so the post-pick fetch is skipped and the place just chosen is never
	 * re-suggested. One divergence from the ref version, accepted and small: after Esc, retyping the exact same string
	 * keeps the list hidden until the query changes.
	 */
	const [dismissed, setDismissed] = useState<string | null>(null)
	const [activeIndex, setActiveIndex] = useState(-1)

	const query = localitySegment(text)
	const debouncedQuery = useDebouncedValue(query, debounceMs)

	const eligible = Boolean(autocomplete) && debouncedQuery.length >= minChars && !/^\d/.test(debouncedQuery)

	const suggestions =
		eligible && fetched?.query === debouncedQuery && dismissed !== debouncedQuery ? fetched.suggestions : NO_SUGGESTIONS

	useEffect(() => {
		if (!autocomplete || debouncedQuery.length < minChars || /^\d/.test(debouncedQuery)) return

		if (dismissed === debouncedQuery) return

		let cancelled = false

		void (async () => {
			try {
				const next = await autocomplete(debouncedQuery)

				if (cancelled) return
				setFetched({ query: debouncedQuery, suggestions: next })
				setActiveIndex(-1)
			} catch {
				if (cancelled) return
				setFetched({ query: debouncedQuery, suggestions: [] })
				setActiveIndex(-1)
			}
		})()

		return () => {
			cancelled = true
		}
	}, [debouncedQuery, autocomplete, minChars, dismissed])

	const pick = useCallback(
		(value: string) => {
			const next = replaceSegment(text, value)

			setText(next)
			// Suppress the fetch the rewritten text would trigger — the segment being typed IS the picked name.
			setDismissed(localitySegment(next))
			setFetched(null)
			setActiveIndex(-1)
		},
		[text, setText]
	)

	const dismiss = useCallback(() => {
		setDismissed(debouncedQuery)
		setActiveIndex(-1)
	}, [debouncedQuery])

	const onInputKeyDown = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			if (!suggestions.length) return

			switch (event.key) {
				case "ArrowDown":
					event.preventDefault()
					setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1))
					break
				case "ArrowUp":
					event.preventDefault()
					setActiveIndex((i) => Math.max(i - 1, 0))
					break
				case "Enter":
					if (activeIndex >= 0 && activeIndex < suggestions.length) {
						event.preventDefault()
						pick(suggestions[activeIndex]!.value)
					}

					break
				case "Escape":
					event.preventDefault()
					dismiss()
					break
			}
		},
		[suggestions, activeIndex, pick, dismiss]
	)

	return {
		suggestions,
		activeIndex,
		setActiveIndex,
		onInputKeyDown,
		pick,
		dismiss,
		inputProps: {
			role: "combobox",
			"aria-expanded": suggestions.length > 0,
			"aria-controls": LISTBOX_ID,
			"aria-autocomplete": "list",
			"aria-activedescendant": activeIndex >= 0 ? optionID(activeIndex) : undefined,
			autoComplete: "off",
		},
		listboxID: LISTBOX_ID,
		optionID,
	}
}
