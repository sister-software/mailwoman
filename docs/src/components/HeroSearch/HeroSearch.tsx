/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hero's search box: a combobox that completes place names from the published autocomplete index through
 *   the shared hook and listbox, and hands the query to Earth on submit. The index loads on the first keystroke,
 *   one file per leading character, and no model or gazetteer reaches this page.
 */

import "@mailwoman/react/styles.css"
import { PlaceAutocomplete } from "@mailwoman/react/map/PlaceAutocomplete"
import type { Suggestion } from "@mailwoman/react/map/types"
import { usePlaceAutocomplete } from "@mailwoman/react/map/usePlaceAutocomplete"
import {
	openPlaceAutocompleteIndex,
	type PlaceAutocompleteIndex,
	suggestionDetail,
} from "mailwoman/browser-runtime/autocomplete-index"
import { useCallback, useRef, useState } from "react"

/**
 * The count of suggestions the hero lists.
 */
const SUGGESTION_LIMIT = 6

export interface HeroSearchProps {
	/**
	 * The page Earth serves the query from.
	 */
	action: string
	placeholder: string
	classes: {
		form: string
		input: string
		submit: string
		label: string
	}
}

export function HeroSearch({ action, placeholder, classes }: HeroSearchProps) {
	const [text, setText] = useState("")
	const index = useRef<PlaceAutocompleteIndex | null>(null)

	const complete = useCallback(async (query: string): Promise<Suggestion[]> => {
		index.current ??= openPlaceAutocompleteIndex()

		const hits = await index.current.query(query, SUGGESTION_LIMIT)

		return hits.map((hit) => ({
			value: hit.name,
			label: `${hit.name} · ${suggestionDetail(hit)}`,
			placetype: hit.placetype,
		}))
	}, [])

	const autocomplete = usePlaceAutocomplete({ text, setText, autocomplete: complete, minChars: 2 })

	return (
		<div className="hero-search">
			<form className={classes.form} action={action} method="get" role="search">
				<label htmlFor="hero-query" className={classes.label}>
					An address to geocode
				</label>
				<input
					{...autocomplete.inputProps}
					id="hero-query"
					name="q"
					type="search"
					className={classes.input}
					placeholder={placeholder}
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={autocomplete.onInputKeyDown}
				/>
				<button type="submit" className={classes.submit}>
					Geocode
				</button>
			</form>
			<PlaceAutocomplete
				suggestions={autocomplete.suggestions}
				activeIndex={autocomplete.activeIndex}
				onPick={autocomplete.pick}
				onHover={autocomplete.setActiveIndex}
				listboxID={autocomplete.listboxID}
				optionID={autocomplete.optionID}
				caption="Places"
			/>
		</div>
	)
}
