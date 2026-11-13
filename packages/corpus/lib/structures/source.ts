// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The contract an official list of public structures satisfies to join the structures layer.
 *
 *   `mailwoman gazetteer build structures` folds every source in `STRUCTURE_SOURCES`
 *   (`#structures/sources`) into one `structures.db`.
 *   A source's identity, terms and reader live in its entry, under its country's
 *   directory (`lib/<cc>/structures/`).
 *
 *   A source may hold one category of structure, such as a postal operator's list of its post offices.
 *   Every record of such a list is filed under the post-office category.
 *
 *   A source may also hold several categories, such as the USGS National Structures Dataset.
 *   The post-office parse suite reads the records filed under {@linkcode postOfficeCategoryID}.
 *
 *   The layer builder reads only the fields below and never branches on a country.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { lookupPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import type { PathBuilder } from "path-ts"

/**
 * Who compiled a list of structures.
 *
 * An operator's own facility list, such as a postal operator's list of its post offices,
 * is the operator's record of where it serves the public.
 * A mapping agency's compilation is another body's observation of those facilities.
 *
 * The layer records the class beside each source so a reader can prefer the operator's record.
 */
export const StructureProvenance = {
	/**
	 * The postal operator's own list of its facilities.
	 */
	PostalOperator: "postal-operator",
	/**
	 * A government mapping agency's compilation, such as the USGS National Map's structures layer.
	 */
	MappingAgency: "mapping-agency",
} as const

export type StructureProvenance = (typeof StructureProvenance)[keyof typeof StructureProvenance]

/**
 * One structure as a source reads it.
 */
export interface StructureRecord {
	/**
	 * The publisher's own identifier for the facility, unique within the source.
	 */
	id: string
	name: string | null
	/**
	 * The `@mailwoman/poi-taxonomy` category id the structure is filed under.
	 * The layer refuses an id the taxonomy doesn't hold.
	 */
	category: string
	/**
	 * `null` when the publisher records no point for the facility.
	 * The layer counts such a record and leaves it out.
	 */
	point: { latitude: number; longitude: number } | null
	/**
	 * The facility's address as the components the parser labels (`house_number`, `street`,
	 * `unit`, `locality`, `region`, `postcode`), split by the country's own reader.
	 * `null` when the publisher records no street address.
	 *
	 * The post-office evaluation suite renders these with the country's address format
	 * and expects the parser to return each one.
	 */
	address: Readonly<Partial<Record<ComponentTag, string>>> | null
}

/**
 * What one read of a source's fetched input yields.
 */
export interface StructureSourceRead {
	/**
	 * The vintage of the input read, such as the date its fetch recorded.
	 */
	vintage: string
	records: AsyncIterable<StructureRecord>
}

/**
 * One country's official list of structures.
 */
export interface StructureSource {
	/**
	 * The stable source id, stored on every row the source contributes (`<id>:<record id>`).
	 */
	id: string
	/**
	 * The ISO 3166-1 alpha-2 code stamped on every row.
	 */
	country: string
	publisher: string
	/**
	 * The credit the layer's manifest states for this source.
	 */
	attribution: string
	/**
	 * The SPDX identifier, or a `LicenseRef-` this repository defines, that the rows arrive under.
	 */
	license: string
	/**
	 * The `sourceID` of the source's row in `data/address-source-register.json`.
	 */
	registerSource: string
	provenance: StructureProvenance
	/**
	 * The command that fetches the input `read` takes.
	 */
	fetchCommand: string
	/**
	 * Reads the fetched input under `sourcesRoot`, the root `mailwoman corpus fetch`
	 * writes current sources to.
	 *
	 * @throws When the input or the record of its fetch is missing.
	 */
	read(sourcesRoot: PathBuilder): Promise<StructureSourceRead>
}

/**
 * The phrase the post-office category is looked up by in the POI taxonomy.
 */
const POST_OFFICE_PHRASE = "post office"

/**
 * The POI taxonomy's category id for a post office, resolved from its phrase.
 *
 * @throws When the taxonomy holds no category for the phrase.
 */
export function postOfficeCategoryID(): string {
	const [match] = lookupPOICategory(POST_OFFICE_PHRASE)

	if (!match) {
		throw new Error(`the POI taxonomy holds no category for the phrase "${POST_OFFICE_PHRASE}"`)
	}

	return match.category.id
}
