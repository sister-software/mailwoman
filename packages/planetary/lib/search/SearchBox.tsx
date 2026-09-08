/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The search box: a combobox over the loaded artifact through the shared autocomplete hook and listbox, so the
 *   keyboard contract (arrows, Enter, Escape) and the ARIA wiring are the Earth geocoder's, not a second copy.
 */

import { PlaceAutocomplete } from "@mailwoman/react/map/PlaceAutocomplete"
import type { Suggestion } from "@mailwoman/react/map/types"
import { usePlaceAutocomplete } from "@mailwoman/react/map/usePlaceAutocomplete"
import { useCallback, useRef, useState } from "react"

import type { PlanetarySearch, SearchHit } from "#search/index"

export interface SearchBoxProps {
	search: PlanetarySearch | null
	placeholder: string
	onSelect: (hit: SearchHit) => void
}

export function SearchBox({ search, placeholder, onSelect }: SearchBoxProps) {
	const [text, setText] = useState("")
	// The hook picks by suggestion VALUE, a string; the hits behind the last answer are kept here so a pick maps back
	// to the feature it named.
	const lastHits = useRef<Map<string, SearchHit>>(new Map())

	const query = useCallback(
		async (value: string): Promise<Suggestion[]> => {
			if (!search) return []

			const hits = search.query(value)

			lastHits.current = new Map(hits.map((hit) => [hit.name, hit]))

			return hits.map((hit) => ({ value: hit.name, placetype: hit.featureType }))
		},
		[search]
	)

	const autocomplete = usePlaceAutocomplete({ text, setText, autocomplete: query, minChars: 2 })

	const pick = (value: string) => {
		const hit = lastHits.current.get(value)

		autocomplete.pick(value)

		if (hit) {
			onSelect(hit)
		}
	}

	return (
		<div className="search-box">
			<input
				{...autocomplete.inputProps}
				type="search"
				value={text}
				placeholder={placeholder}
				aria-label="Search named features"
				disabled={!search}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && autocomplete.activeIndex < 0 && autocomplete.suggestions[0]) {
						event.preventDefault()
						pick(autocomplete.suggestions[0].value)

						return
					}

					autocomplete.onInputKeyDown(event)

					if (event.key === "Enter" && autocomplete.activeIndex >= 0) {
						const active = autocomplete.suggestions[autocomplete.activeIndex]

						const hit = active ? lastHits.current.get(active.value) : undefined

						if (hit) {
							onSelect(hit)
						}
					}
				}}
			/>
			<PlaceAutocomplete
				suggestions={autocomplete.suggestions}
				activeIndex={autocomplete.activeIndex}
				onPick={pick}
				onHover={autocomplete.setActiveIndex}
				listboxID={autocomplete.listboxID}
				optionID={autocomplete.optionID}
				caption="Features:"
			/>
		</div>
	)
}
