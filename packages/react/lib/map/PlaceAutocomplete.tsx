/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders the suggestion listbox. The `usePlaceAutocomplete` hook owns the state and keyboard
 *   navigation.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"
import type { Suggestion } from "#map/types"

/**
 * Props for {@link PlaceAutocomplete}.
 */
export interface PlaceAutocompleteProps {
	/**
	 * The suggestions to render.
	 */
	suggestions: Suggestion[]
	/**
	 * The index highlighted by the keyboard, or `-1` for none.
	 */
	activeIndex: number
	/**
	 * Called with the suggestion's `value` when the visitor clicks it.
	 */
	onPick: (value: string) => void
	/**
	 * Called with the index under the pointer, so that hover moves the highlight.
	 */
	onHover?: (index: number) => void
	/**
	 * The listbox element id.
	 *
	 * Pass `listboxID` from the hook so that it matches the input's `aria-controls`.
	 */
	listboxID: string
	/**
	 * Builds an option element id.
	 * Pass `optionID` from the hook.
	 */
	optionID: (index: number) => string
	/**
	 * The label before the suggestions. @default "Did you mean:"
	 */
	caption?: string
}

/**
 * Renders the suggestion listbox, or nothing when there are no suggestions.
 */
export function PlaceAutocomplete({
	suggestions,
	activeIndex,
	onPick,
	onHover,
	listboxID,
	optionID,
	caption = "Did you mean:",
}: PlaceAutocompleteProps): ReactNode {
	if (!suggestions.length) return null

	return (
		<div className="mw-demo-suggest" id={listboxID} role="listbox" aria-label="Place suggestions">
			<span className="mw-demo-suggest__label">{caption}</span>
			{suggestions.map((s, i) => (
				<button
					key={`${s.value}-${i}`}
					id={optionID(i)}
					type="button"
					role="option"
					aria-selected={i === activeIndex}
					className={cx("mw-chip", { "mw-chip--active": i === activeIndex })}
					onMouseEnter={() => onHover?.(i)}
					onClick={() => onPick(s.value)}
					title={s.placetype}
				>
					{s.label ?? s.value}
				</button>
			))}
		</div>
	)
}
