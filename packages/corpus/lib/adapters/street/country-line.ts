// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The street-line readers a country's own directory supplies, keyed by ISO 3166-1 alpha-2 code.
 *
 * A country whose free-text street line joins several comma-separated parts in an
 * order its postal operator states gets a reader under `lib/<cc>/street-line/`,
 * and an adapter reads a line of that country through this table.
 * A country without an entry has no reader, and an adapter keeps its own split.
 */

import { segmentINStreetLine } from "#in/street-line/segment"

/**
 * The parts a country's reader labels in one street line.
 */
export interface CountryStreetLineParts {
	house_number?: string
	street: string
	dependent_locality?: string
	/**
	 * A building or complex name written before the street (`Tagore Road Hostel`).
	 */
	building?: string
}

/**
 * The record fields beside the line.
 * The line may repeat their values.
 */
export interface CountryStreetLineContext {
	locality?: string | null
	region?: string | null
}

/**
 * Reads one street line, or returns the reason it can't be labeled.
 */
export type CountryStreetLineReader = (
	line: string,
	context: CountryStreetLineContext
) => CountryStreetLineParts | { refused: string }

const COUNTRY_STREET_LINE_READERS: Readonly<Record<string, CountryStreetLineReader>> = {
	IN: (line, context) => {
		const parts = segmentINStreetLine(line, context)

		if ("refused" in parts) return parts

		return {
			...(parts.house_number ? { house_number: parts.house_number } : {}),
			street: parts.street,
			...(parts.dependent_locality ? { dependent_locality: parts.dependent_locality } : {}),
			...(parts.venue ? { building: parts.venue } : {}),
		}
	},
}

/**
 * The street-line reader of `country`, or `null` when its directory supplies none.
 */
export function streetLineReaderFor(country: string): CountryStreetLineReader | null {
	return COUNTRY_STREET_LINE_READERS[country.toUpperCase()] ?? null
}
