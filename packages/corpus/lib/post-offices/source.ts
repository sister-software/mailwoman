// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The contract a country's official post-office list satisfies to join the post-office layer.
 *
 *   `mailwoman gazetteer build post-offices` folds every source in `POST_OFFICE_SOURCES`
 *   (`#post-offices/sources`) into one `post-offices.db`.
 *   A source's identity, terms and reader live in its entry, under its country's
 *   directory (`lib/<cc>/post-offices/`).
 *
 *   The layer builder reads only the fields below and never branches on a country.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { PathBuilder } from "path-ts"

/**
 * Who compiled a post-office list.
 *
 * A postal operator's own facility list is the operator's record of where it serves the public.
 * A mapping agency's compilation is another body's observation of those facilities.
 *
 * The layer records the class beside each source so a reader can prefer the operator's record.
 */
export const PostOfficeProvenance = {
	/**
	 * The postal operator's own list of its facilities.
	 */
	PostalOperator: "postal-operator",
	/**
	 * A government mapping agency's compilation, such as the USGS National Map's structures layer.
	 */
	MappingAgency: "mapping-agency",
} as const

export type PostOfficeProvenance = (typeof PostOfficeProvenance)[keyof typeof PostOfficeProvenance]

/**
 * One post office as a source reads it.
 */
export interface PostOfficeRecord {
	/**
	 * The publisher's own identifier for the facility, unique within the source.
	 */
	id: string
	name: string | null
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
export interface PostOfficeSourceRead {
	/**
	 * The vintage of the input read, such as the date its fetch recorded.
	 */
	vintage: string
	records: AsyncIterable<PostOfficeRecord>
}

/**
 * One country's official post-office list.
 */
export interface PostOfficeSource {
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
	provenance: PostOfficeProvenance
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
	read(sourcesRoot: PathBuilder): Promise<PostOfficeSourceRead>
}
