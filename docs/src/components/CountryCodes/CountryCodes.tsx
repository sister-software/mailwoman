// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Country codes rendered as `<abbr>` elements, so a screen reader and a hover both give the
 *   country's name. The names come from the runtime's ICU region data through `Intl.DisplayNames`.
 */

import { isPresent } from "@mailwoman/core/objects"
import React, { Fragment } from "react"

const regionNames = new Intl.DisplayNames(["en"], { type: "region" })

/**
 * The English name of an ISO 3166-1 alpha-2 code.
 *
 * @throws When ICU has no region name for the code, so a typo fails the docs build
 * instead of rendering a title that repeats the code.
 */
function countryName(code: string): string {
	const name = regionNames.of(code)

	if (!name || name === code) throw new Error(`CountryCodes: no region name for "${code}"`)

	return name
}

export interface CountryProps {
	/**
	 * An ISO 3166-1 alpha-2 code, such as `GB`.
	 */
	code: string
}

/**
 * One country code with its name as the abbreviation's title.
 */
export const Country: React.FC<CountryProps> = ({ code }) => <abbr title={countryName(code)}>{code}</abbr>

export interface CountriesProps {
	/**
	 * ISO 3166-1 alpha-2 codes separated by spaces, in the order to print them.
	 */
	codes: string
	/**
	 * `and` joins the last two codes with "and", as running prose does.
	 *
	 * `plain` separates every code with a comma, as a table cell does.
	 *
	 * @defaultValue "and"
	 */
	join?: "and" | "plain"
}

/**
 * A list of country codes, each one an abbreviation titled with its country's name.
 */
export const Countries: React.FC<CountriesProps> = ({ codes, join = "and" }) => {
	const list = codes.split(/\s+/).filter(isPresent)
	const parts = new Intl.ListFormat("en", { type: join === "and" ? "conjunction" : "unit" }).formatToParts(list)

	return (
		<>
			{parts.map((part, index) => (
				<Fragment key={index}>{part.type === "element" ? <Country code={part.value} /> : part.value}</Fragment>
			))}
		</>
	)
}
