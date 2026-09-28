/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type KeyboardEvent, useCallback, useEffect, useState } from "react"

import { useDebouncedValue } from "#common/useDebouncedValue"
import type { Suggestion } from "#map/types"

/**
 * Options for {@linkcode usePlaceAutocomplete}.
 */
export interface UsePlaceAutocompleteOptions {
	/**
	 * The controlled input text.
	 * The segment after the last comma is the query.
	 */
	text: string

	/**
	 * Sets the input text.
	 * A pick calls it with the last segment replaced.
	 */
	setText: (text: string) => void

	/**
	 * Fetches suggestions for a query.
	 * Without it the hook never suggests anything.
	 */
	autocomplete?: (query: string) => Promise<Suggestion[]>

	/**
	 * @default 2
	 */
	minChars?: number

	/**
	 * @default 150
	 */
	debounceMs?: number
}

/**
 * The combobox ARIA props to spread onto the input.
 */
export interface AutocompleteInputProps {
	role: "combobox"
	"aria-expanded": boolean
	"aria-controls": string
	"aria-autocomplete": "list"
	"aria-activedescendant": string | undefined
	autoComplete: "off"
}

/**
 * The state and handlers that {@linkcode usePlaceAutocomplete} returns.
 */
export interface UsePlaceAutocomplete {
	/**
	 * The current suggestions, empty when none match or the visitor dismissed the list.
	 */
	suggestions: Suggestion[]

	/**
	 * The index highlighted by the keyboard, or `-1` for none.
	 */
	activeIndex: number

	/**
	 * Sets the highlighted index, such as when the pointer enters an option.
	 */
	setActiveIndex: (index: number) => void

	/**
	 * Handles input keys: arrows move the highlight, Enter picks instead of submitting, and Escape dismisses.
	 */
	onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void

	/**
	 * Replaces the text after the last comma with the suggestion and closes the list.
	 */
	pick: (value: string) => void

	/**
	 * Closes the list without picking until the query changes.
	 */
	dismiss: () => void

	/**
	 * The combobox ARIA props to spread onto the input.
	 */
	inputProps: AutocompleteInputProps

	/**
	 * The listbox element ID, which matches `inputProps["aria-controls"]`.
	 */
	listboxID: string

	optionID: (index: number) => string
}

const LISTBOX_ID = "mw-demo-suggest-list"

const NO_SUGGESTIONS: Suggestion[] = []
const optionID = (index: number) => `mw-demo-suggest-${index}`

function localitySegment(text: string): string {
	return (text.includes(",") ? text.slice(text.lastIndexOf(",") + 1) : text).trim()
}

function replaceSegment(current: string, name: string): string {
	return current.includes(",") ? `${current.slice(0, current.lastIndexOf(",") + 1)} ${name}` : name
}

/**
 * Fetches debounced place suggestions for the text after the input's last comma. a pick
 * replaces only that segment, and a digit-leading segment never reaches `autocomplete`.
 */
export function usePlaceAutocomplete({
	text,
	setText,
	autocomplete,
	minChars = 2,
	debounceMs = 150,
}: UsePlaceAutocompleteOptions): UsePlaceAutocomplete {
	const [fetched, setFetched] = useState<{ query: string; suggestions: Suggestion[] } | null>(null)

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
