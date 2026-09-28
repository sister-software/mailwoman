/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The `usePlaceAutocomplete` hook owns the state and keyboard navigation.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"
import type { Suggestion } from "#map/types"

/**
 * Props for {@link PlaceAutocomplete}.
 */
export interface PlaceAutocompleteProps {
	suggestions: Suggestion[]
	/**
	 * The index highlighted by the keyboard, or `-1` for none.
	 */
	activeIndex: number
	onPick: (value: string) => void
	onHover?: (index: number) => void
	/**
	 * The listbox element id, passed from the hook so it matches the input's `aria-controls`.
	 */
	listboxID: string
	/**
	 * Pass `optionID` from the hook.
	 */
	optionID: (index: number) => string
	/**
	 * The label before the suggestions. @default "Did you mean:"
	 */
	caption?: string
}

/**
 * Renders the suggestion listbox when suggestions exist, and no listbox otherwise.
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
