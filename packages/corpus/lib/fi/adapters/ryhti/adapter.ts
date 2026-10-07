/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ryhti`: Suomen ympäristökeskus' Ryhti built-environment address CSV adapter, covering Finland
 * and Åland.
 *
 * Input is the comma-separated `open_address.csv.gz`, decompressed, that SYKE publishes for the
 * whole country at `https://paikkatiedot.ymparisto.fi/geoserver/www/open_address.csv.gz`.
 * The file quotes fields, so the reader is quote-aware: a split on `,` misaligns every column
 * and reports 460 distinct `municipality_number` values where 308 exist.
 * Which columns are quoted is a property of the edition rather than of the format.
 * The edition served on 2026-10-02, `last-modified` `Thu, 1 Oct 2026 05:20:03 GMT` and
 * `content-length` 351288399, quotes `address_number`, the two number-part columns,
 * `municipality_number`, `postal_code` and `location_srid`, leaving the header and
 * every name column bare.
 *
 * A row's country comes from `municipality_number` rather than from the caller. Åland is part of
 * Finland and its sixteen municipalities have Finnish municipality numbers, so one national file
 * holds both jurisdictions and {@linkcode ALAND_MUNICIPALITIES} separates them.
 *
 * The street and the house number are read from the publisher's own part columns rather than from
 * its inline address text.
 * `address_name_fin` is the whole of `address_fin` or a space-delimited prefix of it, and the four
 * number-part columns reproduce the publisher's inline number.
 * No row publishes inline address text with both name columns empty, so the part columns lose no
 * address.
 *
 * `address_number` is not a house number. It is a 1-based ordinal over the addresses that share one
 * `building_key`. That is how a corner building's several frontages are numbered. The adapter
 * ignores it.
 *
 * The file is bilingual, and which column holds which language depends on the municipality. On
 * mainland Finland `address_name_fin` is the Finnish name and `address_name_swe` the Swedish one. On
 * Åland the `*_fin` columns, where populated at all, hold the **Swedish** name: `address_fin` reads
 * `Skogshyddsvägen 11`.
 * So the adapter prefers `*_swe` on Åland and `*_fin` on the mainland, and emits one row per
 * published record from the preferred language's columns.
 * `locale` states the language of the name it emitted rather than the language of the column that
 * name came from. That gives three values.
 * `fi-FI` is a mainland record whose name came from `address_name_fin`.
 * `sv-FI` is a mainland record that populates `address_name_swe` only. That is the form a
 * Swedish-speaking municipality publishes.
 * `sv-AX` is every Åland record, because the Swedish columns are the populated ones there and the
 * `*_fin` columns hold the Swedish name where they are populated at all.
 * A mainland record's Swedish name, where the record publishes both, is not emitted as a second
 * row: a record is one premise, and `CanonicalRow` holds one written surface.
 *
 * SYKE's metadata record `{DBD610F4-3392-44CD-B601-BAE8FA547A57}` grants CC BY 4.0 for its open data
 * and the register's two elected decisions for this file record `CC-BY-4.0` in their `spdx` field, so
 * the adapter records that license on every row. SYKE states the attribution it wants as
 * `Lähde: Syke Ryhti`, and the model card must state it.
 *
 * The adapter streams with `CSVSpliterator.fromAsync`, so the 3.8M-row file never sits in memory. It
 * honors `opts.limit`, `opts.signal` and `opts.country`.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { CSVSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const RYHTI_ADAPTER_ID = "ryhti"

/**
 * The sixteen `municipality_number` values of Åland's municipalities.
 *
 * Every other number in the file belongs to a mainland Finnish municipality.
 *
 * The column is a zero-padded three-digit string, so a reader compares the padded form.
 */
export const ALAND_MUNICIPALITIES: ReadonlySet<string> = new Set([
	"035", // Brändö
	"043", // Eckerö
	"060", // Finström
	"062", // Föglö
	"065", // Geta
	"076", // Hammarland
	"170", // Jomala
	"295", // Kumlinge
	"318", // Kökar
	"417", // Lemland
	"438", // Lumparland
	"478", // Mariehamn
	"736", // Saltvik
	"766", // Sottunga
	"771", // Sund
	"941", // Vårdö
])

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const RYHTI_COUNTRIES: readonly string[] = ["FI", "AX"]

/**
 * The subset of the 24 columns the adapter consults.
 *
 * The explicit shape catches a column rename early.
 * `address_fin` and `address_swe`, the publisher's inline address text, are deliberately
 * absent: the street and the number come from the part columns instead.
 */
interface RyhtiRow extends RyhtiNumberParts {
	address_key: string
	postal_office_fin: string
	postal_office_swe: string
	address_name_fin: string
	address_name_swe: string
	municipality_number: string
	postal_code: string
}

/**
 * The four columns that hold a house number, declared as one shape because
 * {@linkcode composeRyhtiHouseNumber} reads these four columns and derives the number from them.
 */
interface RyhtiNumberParts {
	number_part_of_address_number: string
	number_part_of_address_number2: string
	subdivision_letter_of_address_number: string
	subdivision_letter_of_address_number2: string
}

/**
 * The country a row belongs to, read from its municipality number.
 *
 * The comparison is against the zero-padded three-digit form the file publishes,
 * and a shorter value is padded rather than refused, so `35` reads as Brändö.
 */
export function countryOfFinnishMunicipality(municipalityNumber: string): string {
	const padded = municipalityNumber.trim().padStart(3, "0")

	return ALAND_MUNICIPALITIES.has(padded) ? "AX" : "FI"
}

/**
 * The house number, composed from the four part columns.
 *
 * SYKE splits `41a` into a number part and a subdivision letter, and a range such
 * as `184-183b` across a second pair of the same two columns.
 * The second pair is appended after a hyphen when either of its halves is populated.
 *
 * @returns The composed number, or an empty string for a row with no number at all.
 * A caller treats that empty string as a place name rather than a number.
 */
export function composeRyhtiHouseNumber(record: Partial<RyhtiNumberParts>): string {
	const first = composeHouseNumber(
		record.number_part_of_address_number ?? "",
		record.subdivision_letter_of_address_number ?? ""
	)

	if (!first) return ""

	const secondNumber = (record.number_part_of_address_number2 ?? "").trim()
	const secondLetter = (record.subdivision_letter_of_address_number2 ?? "").trim()

	if (!secondNumber && !secondLetter) return first

	return `${first}-${secondNumber}${secondLetter}`
}

/**
 * The street name, postal place and language of the row an adapter emits for one record.
 */
interface NamedSurface {
	street: string
	locality: string
	/**
	 * The BCP-47 language subtag of {@linkcode NamedSurface.street}.
	 */
	language: string
}

/**
 * The surface to emit for one record, or `undefined` for a record with no street.
 *
 * On Åland the Swedish columns are preferred, and the Finnish ones are read as Swedish.
 * That is the language they hold there.
 *
 * On the mainland the Finnish columns are preferred.
 * The Swedish ones stand in where `address_name_fin` is empty.
 * That is the form a Swedish-speaking municipality publishes.
 *
 * A language whose name column is empty has no street.
 * Seven mainland rows publish an `address_swe` of a bare number with an empty `address_name_swe`.
 * This refuses them rather than giving them an empty street.
 */
function surfaceOf(record: RyhtiRow, country: string): NamedSurface | undefined {
	const finnish = {
		street: (record.address_name_fin ?? "").trim(),
		locality: (record.postal_office_fin ?? "").trim(),
	}

	const swedish = {
		street: (record.address_name_swe ?? "").trim(),
		locality: (record.postal_office_swe ?? "").trim(),
	}

	if (country === "AX") {
		const preferred = swedish.street ? swedish : finnish

		return preferred.street ? { ...preferred, language: "sv" } : undefined
	}

	if (finnish.street) return { ...finnish, language: "fi" }

	return swedish.street ? { ...swedish, language: "sv" } : undefined
}

export function createRyhtiAdapter(): CorpusAdapter {
	return {
		id: RYHTI_ADAPTER_ID,
		defaultLicense: "CC-BY-4.0",
		addressRole: AddressRole.Premise,
		register: SourceRegister.RyhtiBuildingAddress,
		surface: SurfaceOrigin.Rendered,
		description:
			"Ryhti built-environment building address data (Suomen ympäristökeskus): street-level addresses for Finland and Åland.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !RYHTI_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(RYHTI_ADAPTER_ID, RYHTI_COUNTRIES, opts.country)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
			})

			let emitted = 0
			let unnamed = 0

			try {
				for await (const record of rows as AsyncIterable<RyhtiRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const country = countryOfFinnishMunicipality(record.municipality_number ?? "")

					// A caller that requested one jurisdiction gets that jurisdiction's rows,
					// so the one national file can be read once per country.
					if (opts.country && country !== opts.country) continue

					const surface = surfaceOf(record, country)

					if (!surface) {
						unnamed += 1

						continue
					}

					const postcode = (record.postal_code ?? "").trim()

					if (!postcode && !surface.locality) continue

					const house = composeRyhtiHouseNumber(record)
					const components: CanonicalRow["components"] = {}

					if (house) {
						components.house_number = house
					}

					components.street = surface.street

					if (postcode) {
						components.postcode = postcode
					}

					if (surface.locality) {
						components.locality = surface.locality
					}

					const rendered = formatAddressRow(components, country, { singleLine: true })

					if (!rendered) continue

					const { raw, components: aligned } = rendered
					const key = (record.address_key ?? "").trim()

					const sourceID = key ? `${RYHTI_ADAPTER_ID}-${key}` : stableSourceID(RYHTI_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country,
						locale: `${surface.language}-${country}`,
						source: RYHTI_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: "CC-BY-4.0",
					}

					emitted++
				}
			} finally {
				if (unnamed > 0) {
					process.stderr.write(
						`  ryhti: ${unnamed} rows name no street in either language and were dropped, ${emitted} kept\n`
					)
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const ryhtiAdapter = createRyhtiAdapter()
