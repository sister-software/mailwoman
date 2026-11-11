/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pinned sources of the open profile, and the lock that records the bytes a build read.
 *
 *   A source is a published file at one URL. The lock records its SHA-256 and byte count, the publication marker the
 *   server stated (`Last-Modified` or `ETag`), and the publisher's statement of terms. A build reads the locked bytes
 *   from the data root and refuses bytes whose digest differs, so a moving `latest` never enters an artifact unnoticed.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
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
export const SOURCE_IDS = ["ourairports-airports", "ourairports-countries", "wikidata-iso3166-1"] as const

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
 * Where the pinned bytes of a source live.
 */
export function sourcePath(source: SourceDefinition): PathBuilder {
	return dataRootPath("corpus", "sources", "registry", source.file)
}
