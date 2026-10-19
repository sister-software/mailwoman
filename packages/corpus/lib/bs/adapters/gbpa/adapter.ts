/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `gbpa-bs`: the address points of the Grand Bahama Port Authority (GBPA), covering the City of Freeport
 * and Lucaya on Grand Bahama, which the GBPA publishes in its `GBPA/gis-datafiles` repository on GitHub.
 * The adapter reads the CSV export, `CSV/addresses.csv`.
 *
 * A Freeport address number is a block and a parcel joined by a hyphen (`8-29 Seagull Drive`), and either
 * part may be lettered (`UU-3`, `13-43C`, `W-A-10`). The adapter reads `AddressNum` as the house number,
 * `FullStName` as the street, `City` as the locality, `Island` as the region and `AltName` as a venue
 * (`Lucayan International School`, `Shoreline`). The export truncates some parcel ids to five characters and
 * a star (`Minis*`), and those numbers are dropped.
 *
 * The export repeats the street's name in a few records (`Rippindale Rippindale`, and across an embedded
 * line break `Santa Maria \r\nSanta Maria Avenue`). The adapter collapses the repeat and counts it.
 *
 * The GBPA licenses the data under CC BY 4.0 and asks for the statement "Data Provided by The Grand Bahama
 * Port Authority". Every row records that license.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceIDFromParts } from "#adapters/source-id"
import { SourceRegister } from "#registers"
import {
	AddressRole,
	type AdapterOptions,
	type CanonicalRow,
	type CorpusAdapter,
	countDropped,
	SurfaceOrigin,
} from "#types"

/**
 * Registry id for this adapter, stamped into every row it emits.
 */
export const GBPA_BS_ADAPTER_ID = "gbpa-bs"

/**
 * The license the GBPA publishes the repository's data under.
 */
export const GBPA_BS_LICENSE = "CC-BY-4.0"

/**
 * The attribution statement the GBPA asks for.
 */
export const GBPA_BS_ATTRIBUTION = "Data Provided by The Grand Bahama Port Authority"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const GBPA_BS_COUNTRIES: readonly string[] = ["BS"]

/**
 * The columns the adapter reads from `CSV/addresses.csv`.
 */
export interface GBPAAddressRecord {
	Y: string
	X: string
	AddID: string
	AltName: string
	Suffix: string
	FullStName: string
	AddressNum: string
	City: string
	Island: string
}

/**
 * A value with its whitespace, including the export's embedded line breaks, collapsed, or null when empty.
 */
function present(value: string | undefined): string | null {
	const trimmed = value?.replaceAll(/\s+/gu, " ").trim() ?? ""

	return trimmed || null
}

/**
 * A block and parcel number: alphanumeric parts joined by hyphens (`8-29`, `UU-3`, `W-A-10`, `G-3B10`, `L`).
 */
const ADDRESS_NUMBER = /^[A-Z\d]+(?:-[A-Z\d]+)*$/iu

/**
 * A street's name repeated before its type (`Santa Maria Santa Maria Avenue`)
 * or after it (`Wragby Wragby`).
 */
const REPEATED_NAME = /^(.+?) \1(?= |$)/u

/**
 * A street value that is only a type word, with no name before it.
 */
const TYPE_WORD_ONLY = /^(?:road|lane|drive|avenue|street|court|close|way|place|circle|terrace|crescent)$/iu

/**
 * Initials and a surname alone (`J.S. Johnson`) name a person rather than a place or a business.
 */
const INITIALS_AND_SURNAME = /^(?:\p{Lu}\.\s*)+\p{Lu}\p{Ll}+$/u

/**
 * Maps one record onto the components the corpus asserts, or returns null when the row is refused.
 *
 * Each refusal and each dropped or repaired component increments its reason in `dropped`.
 */
export function componentsForGBPARecord(
	record: GBPAAddressRecord,
	dropped?: Pick<AdapterOptions, "dropped">
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}
	let street = present(record.FullStName)

	if (!street) {
		countDropped(tally, "row:no-street")

		return null
	}

	if (REPEATED_NAME.test(street)) {
		street = street.replace(REPEATED_NAME, "$1")
		countDropped(tally, "component:street:repeated-name-collapsed")
	}

	if (TYPE_WORD_ONLY.test(street)) {
		countDropped(tally, "row:street-is-a-type-word")

		return null
	}

	const components: CanonicalRow["components"] = { street }
	const number = present(record.AddressNum)

	if (number && ADDRESS_NUMBER.test(number)) {
		components.house_number = number
	} else if (number?.includes("*")) {
		countDropped(tally, "component:house_number:truncated")
	} else if (number) {
		countDropped(tally, "component:house_number:not-a-block-parcel-number")
	}

	const venue = present(record.AltName)

	if (venue && !/\p{L}{3}/u.test(venue)) {
		countDropped(tally, "component:venue:code")
	} else if (venue && /(\p{L})\1{3,}$/u.test(venue)) {
		// `Bellevue Gifts & Suppliesccccc` carries a run of repeated keystrokes.
		countDropped(tally, "component:venue:malformed")
	} else if (venue && INITIALS_AND_SURNAME.test(venue)) {
		countDropped(tally, "component:venue:names-a-person")
	} else if (venue) {
		components.venue = venue
	}

	if (!components.house_number && !components.venue) {
		countDropped(tally, "row:no-house-number-or-name")

		return null
	}

	const locality = present(record.City)
	const region = present(record.Island)

	if (locality) {
		components.locality = locality
	}

	if (region) {
		components.region = region
	}

	if (!components.locality) {
		countDropped(tally, "row:no-locality")

		return null
	}

	return components
}

export function createGBPAAdapter(): CorpusAdapter {
	return {
		id: GBPA_BS_ADAPTER_ID,
		defaultLicense: GBPA_BS_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.GrandBahamaPortAuthorityAddresses,
		surface: SurfaceOrigin.Rendered,
		description: "Grand Bahama Port Authority address points (Freeport and Lucaya), GBPA/gis-datafiles CSV export.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !GBPA_BS_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(GBPA_BS_ADAPTER_ID, GBPA_BS_COUNTRIES, opts.country)
			}

			// The file is 8 MB, so it is decoded whole.
			// The BOM would otherwise prefix the first header.
			const text = (await readLocalBuffer(resolvePath(opts.inputPath))).toString("utf8").replace(/^﻿/u, "")
			const records = CSVSpliterator.from<GBPAAddressRecord>(Buffer.from(text, "utf8"), { normalizeKeys: false })
			let emitted = 0

			for (const record of records) {
				if (opts.signal?.aborted) return

				if (opts.limit && emitted >= opts.limit) return

				const components = componentsForGBPARecord(record, opts)

				if (!components) continue

				const rendered = formatAddressRow(components, "BS", { singleLine: true })

				if (!rendered) {
					countDropped(opts, "row:render-failed")

					continue
				}

				for (const tag of rendered.unplaced) {
					countDropped(opts, `component:${tag}:not-rendered`)
				}

				const { raw, components: aligned } = rendered

				yield {
					raw,
					components: aligned,
					country: "BS",
					locale: "en-BS",
					source: GBPA_BS_ADAPTER_ID,
					// The GBPA's own address id separates two points the rendered components cannot.
					source_id: stableSourceIDFromParts(GBPA_BS_ADAPTER_ID, { ...aligned, add_id: record.AddID ?? "" }),
					corpus_version: "",
					license: GBPA_BS_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const gbpaAdapter = createGBPAAdapter()
