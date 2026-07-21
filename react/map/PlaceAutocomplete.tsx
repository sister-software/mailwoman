/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<PlaceAutocomplete>` — the "Did you mean" suggestion listbox from the demo (`_app.tsx:1394-1418`), as
 *   a dumb presentational unit. It renders the current suggestions with the keyboard-highlighted active
 *   descendant; the state + keyboard nav live in {@link usePlaceAutocomplete}. Renders `null` when there
 *   is nothing to suggest, so the row only appears when useful. Wire the ids from the hook so the input's
 *   `aria-controls` / `aria-activedescendant` match this listbox.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import { cx } from "../common/cx.ts"
import type { Suggestion } from "./types.ts"

export interface PlaceAutocompleteProps {
	/** The suggestions to render (from {@link usePlaceAutocomplete}). */
	suggestions: Suggestion[]
	/** The keyboard-highlighted index; `-1` for none. */
	activeIndex: number
	/** Fired (with the suggestion `value`) when one is clicked. */
	onPick: (value: string) => void
	/** Fired with the index a pointer entered, so hover matches keyboard highlight. */
	onHover?: (index: number) => void
	/** The listbox element id — pass `listboxId` from the hook (matches the input's `aria-controls`). */
	listboxId: string
	/** Build the option element id — pass `optionId` from the hook. */
	optionId: (index: number) => string
	/** Leading label. @default "Did you mean:" */
	caption?: string
}

/** The suggestion listbox. */
export function PlaceAutocomplete({
	suggestions,
	activeIndex,
	onPick,
	onHover,
	listboxId,
	optionId,
	caption = "Did you mean:",
}: PlaceAutocompleteProps): ReactNode {
	if (suggestions.length === 0) return null

	return (
		<div className="mw-demo-suggest" id={listboxId} role="listbox" aria-label="Place suggestions">
			<span className="mw-demo-suggest__label">{caption}</span>
			{suggestions.map((s, i) => (
				<button
					key={`${s.value}-${i}`}
					id={optionId(i)}
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
