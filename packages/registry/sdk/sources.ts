// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The pinned sources of the open profile, and the lock that records the bytes a build read.
 *
 *   A source is a published file at one URL.
 *   The lock records its SHA-256 and byte count, the publication marker the server stated
 *   (`Last-Modified` or `ETag`), and the publisher's statement of terms.
 *
 *   A build reads the locked bytes from the data root and refuses bytes whose digest differs,
 *   so a moving `latest` never enters an artifact unnoticed.
 */

import { currentSourcePath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"

/**
 * The profile the open sources compile into.
 *
 * `open-2026-11` is the identifier of the source set below.
 * A different source set is a different profile, so an artifact built from an official IATA
 * or ISO feed would hold another identifier rather than this one.
 */
export const OPEN_PROFILE = "open-2026-11"

/**
 * One pinned source.
 */
export interface SourceDefinition {
	id: SourceID
	url: string
	/**
	 * The file name under the data root.
	 */
	file: string
	/**
	 * The publisher's own statement of the terms, quoted, and where it was read.
	 */
	terms: {
		statement: string
		readAt: string
		/**
		 * Whether the repository elects the source for redistribution in a built artifact.
		 */
		elected: boolean
	}
	/**
	 * Which namespaces the source feeds.
	 */
	feeds: readonly string[]
}

/**
 * The identifiers of the open profile's sources, as the lock keys them.
 */
export const SOURCE_IDS = [
	"iana-language-subtags",
	"ourairports-airports",
	"ourairports-countries",
	"wikidata-iso3166-1",
	"wikidata-memberships-p463",
	"wikidata-memberships-p527",
	"worldbank-countries",
	"wikipedia-developed-country",
] as const

export type SourceID = (typeof SOURCE_IDS)[number]

/**
 * The SPARQL query that reads every item holding an ISO 3166-1 alpha-2, alpha-3 and numeric code.
 *
 * `wdt:` reads the best-rank claim.
 * A state that's ended, such as the German Democratic Republic (`DD`) or the Netherlands Antilles
 * (`AN`), keeps its codes as best-rank claims, so the query also reads the dissolution date (P576)
 * and the normalizer records such an entry as `formerly-used` rather than `officially-assigned`.
 *
 * An item holding all three codes is the ISO entry.
 * An item with only one of them is a region or a historical entry and is left out on purpose.
 */
export const ISO3166_1_QUERY = `SELECT ?item ?itemLabel ?alpha2 ?alpha3 ?numeric ?dissolved WHERE {
  ?item wdt:P297 ?alpha2; wdt:P298 ?alpha3; wdt:P299 ?numeric.
  OPTIONAL { ?item wdt:P576 ?dissolved. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?alpha2 ?item`

/**
 * The Wikidata Query Service endpoint the ISO 3166-1 query is sent to.
 */
export const WIKIDATA_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"

/**
 * The grouping declarations, read for the organization items the membership query asks about.
 */
export interface GroupingDefinitions {
	schemaVersion: number
	groupings: Array<{
		id: string
		name: string
		kind: "organization" | "classification"
		source:
			| { type: "wikidata"; item: string; property: "P463" | "P527" | "both" }
			| { type: "worldbank-income"; level: string }
			| { type: "wikipedia-imf-advanced"; aliases: Record<string, string> }
	}>
	/**
	 * Wikidata items that hold a membership for an ISO entry whose code sits on
	 * another item, mapped to that code.
	 */
	entities: Record<string, string>
	/**
	 * Wikidata role items mapped to the role they give a membership statement.
	 */
	roles: Record<string, "member" | "associate" | "observer" | "suspended" | "other">
}

// The definitions decide the query text, and the query text is part of the locked URL,
// so a changed definition list is a changed source that a fetch refuses until `--repin`.
const GROUPING_DEFINITIONS = await readLocalJSONFile<GroupingDefinitions>(
	workspacePath("registry", "definitions", "groupings.json")
)

const ORGANIZATION_VALUES = GROUPING_DEFINITIONS.groupings
	.flatMap((grouping) => (grouping.source.type === "wikidata" ? [`wd:${grouping.source.item}`] : []))
	.join(" ")

/**
 * A SPARQL query that reads every membership statement of the declared organizations through one property.
 *
 * P463 ("member of") sits on the member and P527 ("has part(s)") sits on the organization.
 * Both are read so the normalizer can take membership from the property a definition names
 * and report where the other disagrees.
 *
 * Each row is one statement and one of its role values, with its rank and its start
 * and end times at their stated precision.
 * A statement with no role yields one row with `?role` unbound.
 *
 * Each property is its own query: on 2026-11-24 the query service answered each
 * in under 4 s and timed out at 65 s on their UNION.
 */
export function membershipsQuery(property: "P463" | "P527"): string {
	const pattern =
		property === "P463"
			? "?member p:P463 ?statement . ?statement ps:P463 ?org ."
			: "?org p:P527 ?statement . ?statement ps:P527 ?member ."

	return `SELECT ?org ?member ?statement ?rank ?role ?start ?startPrecision ?end ?endPrecision WHERE {
  VALUES ?org { ${ORGANIZATION_VALUES} }
  ${pattern}
  ?statement wikibase:rank ?rank .
  OPTIONAL { ?statement pq:P2868 ?role . }
  OPTIONAL { ?statement pqv:P580 ?startNode . ?startNode wikibase:timeValue ?start ; wikibase:timePrecision ?startPrecision . }
  OPTIONAL { ?statement pqv:P582 ?endNode . ?endNode wikibase:timeValue ?end ; wikibase:timePrecision ?endPrecision . }
}
ORDER BY ?org ?member ?statement ?role`
}

/**
 * The revision of the English Wikipedia article "Developed country" whose "IMF
 * advanced economies" section the IMF classification is read from.
 *
 * The section lists the economies of the IMF World Economic Outlook statistical appendix it cites.
 * A revision is immutable, so the pinned bytes change only when this number does.
 */
export const DEVELOPED_COUNTRY_REVISION = 1_387_385_587

/**
 * The open profile's sources.
 *
 * The UN Statistics Division's M49 crosswalk isn't among them.
 * The UN terms of use (https://www.un.org/en/about-us/terms-of-use, read 2026-11-06)
 * grant "personal, non-commercial use, without any right to resell or redistribute"
 * and exclude the right "to compile or create derivative works therefrom".
 *
 * A compiled artifact in a redistributed package is both, so the source is
 * recorded as not elected rather than pinned.
 */
export const SOURCES: readonly SourceDefinition[] = [
	{
		id: "iana-language-subtags",
		url: "https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry",
		file: "iana-language-subtag-registry.txt",
		terms: {
			statement:
				"IANA and IETF intend that the Protocol Registries may be freely used by any party for any purpose. " +
				"Any applicable rights that they may have in the Protocol Registries are subject to the Creative Commons CC0 1.0 dedication.",
			readAt: "https://www.iana.org/help/licensing-terms",
			elected: true,
		},
		feeds: ["bcp47-language", "bcp47-extlang", "iso15924-script", "bcp47-region", "bcp47-variant"],
	},
	{
		id: "ourairports-airports",
		url: "https://davidmegginson.github.io/ourairports-data/airports.csv",
		file: "ourairports-airports.csv",
		terms: {
			statement:
				"All data is released to the Public Domain, and comes with no guarantee of accuracy or fitness for use.",
			readAt: "https://ourairports.com/data/",
			elected: true,
		},
		feeds: ["iata-location", "icao-location"],
	},
	{
		id: "ourairports-countries",
		url: "https://davidmegginson.github.io/ourairports-data/countries.csv",
		file: "ourairports-countries.csv",
		terms: {
			statement:
				"All data is released to the Public Domain, and comes with no guarantee of accuracy or fitness for use.",
			readAt: "https://ourairports.com/data/",
			elected: true,
		},
		feeds: ["iso3166-1-alpha2"],
	},
	{
		id: "wikidata-iso3166-1",
		url: `${WIKIDATA_SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(ISO3166_1_QUERY)}`,
		file: "wikidata-iso3166-1.json",
		terms: {
			statement:
				"Wikidata publishes its structured data under the Creative Commons CC0 1.0 Universal public domain dedication.",
			readAt: "https://www.wikidata.org/wiki/Wikidata:Licensing",
			elected: true,
		},
		feeds: ["iso3166-1-alpha2", "iso3166-1-alpha3", "iso3166-1-numeric"],
	},
	...(["P463", "P527"] as const).map((property): SourceDefinition => ({
		id: `wikidata-memberships-${property.toLowerCase() as "p463" | "p527"}`,
		url: `${WIKIDATA_SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(membershipsQuery(property))}`,
		file: `wikidata-memberships-${property.toLowerCase()}.json`,
		terms: {
			statement:
				"Wikidata publishes its structured data under the Creative Commons CC0 1.0 Universal public domain dedication.",
			readAt: "https://www.wikidata.org/wiki/Wikidata:Licensing",
			elected: true,
		},
		feeds: ["country-grouping"],
	})),
	{
		id: "worldbank-countries",
		url: "https://api.worldbank.org/v2/country?format=json&per_page=400",
		file: "worldbank-countries.json",
		terms: {
			statement:
				"Unless otherwise noted, these Datasets are provided to you under a Creative Commons Attribution 4.0 " +
				"International License (CC BY 4.0). Attribution: The World Bank: Dataset name: Data source (if known).",
			readAt: "https://www.worldbank.org/ext/en/legal/terms-conditions/datasets",
			elected: true,
		},
		feeds: ["country-grouping"],
	},
	{
		id: "wikipedia-developed-country",
		url: `https://en.wikipedia.org/w/index.php?title=Developed_country&oldid=${DEVELOPED_COUNTRY_REVISION}&action=raw`,
		file: "wikipedia-developed-country.wikitext",
		terms: {
			statement:
				"The source is read for the list of economies the IMF classifies as advanced, which is a list of facts. " +
				"The article's prose is CC BY-SA 4.0 and isn't redistributed.",
			readAt: "https://en.wikipedia.org/wiki/Wikipedia:Copyrights",
			elected: true,
		},
		feeds: ["country-grouping"],
	},
]

/**
 * One source's record in `data/manifests/sources.lock.json`.
 */
export interface SourceLockEntry {
	url: string
	sha256: string
	bytes: number
	/**
	 * The publication marker the server stated when the bytes were read:
	 * `Last-Modified`, else `ETag`, else `unstated`.
	 */
	publication: string
	terms: SourceDefinition["terms"]
	feeds: readonly string[]
}

export interface SourceLock {
	profile: string
	sources: Record<SourceID, SourceLockEntry>
	/**
	 * Sources considered and refused, with the terms that refused them.
	 */
	$notElected: Record<string, { url: string; terms: string; readAt: string }>
}

/**
 * Where the pinned bytes of a source live: a current source under the cache root.
 *
 * A fetch checks the bytes against the lock, and fetches them again after the cache root is cleared.
 */
export function pinnedSourceFile(source: SourceDefinition): PathBuilder {
	return currentSourcePath("registry", source.file)
}
