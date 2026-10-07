/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `matrikkelen`: Kartverket's `Matrikkelen - Adresse` CSV adapter, covering Norway and Svalbard.
 *
 * Input is a semicolon-separated CSV from Geonorge, published per area beside a whole-country
 * extract. Both have the same 46 columns, so one reader serves either. The adapter reads
 * `adressenavn` as the street, `nummer` and `bokstav` as the house number, and `postnummer` with
 * `poststed` as the postcode and its postal place.
 *
 * A row's country comes from `kommunenummer` rather than from the caller. Svalbard is municipality
 * 2100 and is its own ISO 3166-1 jurisdiction, so the dataset's own area list is what separates the
 * two: Geonorge offers Svalbard as `kommune` 2100 and `fylke` 21 beside the `landsdekkende` whole of
 * the mainland.
 *
 * Kartverket states CC BY 4.0 for this dataset across five agreeing metadata fields, so the adapter
 * records that license on every row and the model card must attribute Kartverket.
 *
 * The adapter streams with `CSVSpliterator.fromAsync`, so the 2.6M-row mainland extract never sits
 * in memory. It honors `opts.limit`, `opts.signal` and `opts.country`.
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
export const MATRIKKELEN_ADAPTER_ID = "matrikkelen"

/**
 * The municipality number Kartverket gives Svalbard.
 *
 * Every other number in the dataset belongs to a mainland municipality.
 * Jan Mayen has no entry, although ISO 3166-1 assigns `SJ` to it as well as to Svalbard.
 */
const SVALBARD_MUNICIPALITY = "2100"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const MATRIKKELEN_COUNTRIES: readonly string[] = ["NO", "SJ"]

/**
 * The subset of the 46 columns the adapter consults.
 *
 * The explicit shape catches a column rename early.
 * The first column's name has a byte-order mark in the published file.
 *
 * The adapter reads `adresseId` instead, so no field here depends on that spelling.
 */
interface MatrikkelenRow {
	kommunenummer: string
	adressetype: string
	adressenavn: string
	nummer: string
	bokstav: string
	adresseTekst: string
	postnummer: string
	poststed: string
	adresseId: string
}

/**
 * The country a row belongs to, read from its municipality number.
 */
export function countryOfMunicipality(kommunenummer: string): string {
	return kommunenummer.trim() === SVALBARD_MUNICIPALITY ? "SJ" : "NO"
}

export function createMatrikkelenAdapter(): CorpusAdapter {
	return {
		id: MATRIKKELEN_ADAPTER_ID,
		defaultLicense: "CC-BY-4.0",
		addressRole: AddressRole.Premise,
		register: SourceRegister.MatrikkelenAdresse,
		surface: SurfaceOrigin.Rendered,
		description: "Matrikkelen - Adresse (Kartverket): street-level addresses for Norway and Svalbard.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !MATRIKKELEN_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(MATRIKKELEN_ADAPTER_ID, MATRIKKELEN_COUNTRIES, opts.country)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
				columnDelimiter: ";",
			})

			let emitted = 0
			let cadastral = 0

			try {
				for await (const record of rows as AsyncIterable<MatrikkelenRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const country = countryOfMunicipality(record.kommunenummer ?? "")

					if (opts.country && country !== opts.country) continue

					// A `matrikkeladresse` addresses a cadastral unit rather than a street, so its
					// `adresseTekst` reads as a farm name and a holding number, such as `Øvrabø, 124/1`.
					// It has no street to align, and the mainland file holds 34,522 of them
					// against 2,568,832 `vegadresse` rows.
					if ((record.adressetype ?? "").trim() !== "vegadresse") {
						cadastral += 1

						continue
					}

					const street = (record.adressenavn ?? "").trim()
					// Kartverket splits `12B` into `nummer` 12 and `bokstav` B, and writes
					// them joined with no separator in `adresseTekst`.
					const house = composeHouseNumber(record.nummer ?? "", record.bokstav ?? "")
					const postcode = (record.postnummer ?? "").trim()
					const locality = (record.poststed ?? "").trim()

					if (!street) continue

					if (!postcode && !locality) continue

					const components: CanonicalRow["components"] = {}

					if (house) {
						components.house_number = house
					}

					components.street = street

					if (postcode) {
						components.postcode = postcode
					}

					if (locality) {
						components.locality = locality
					}

					const rendered = formatAddressRow(components, country, { singleLine: true })

					if (!rendered) continue

					const { raw, components: aligned } = rendered
					const seed = (record.adresseId ?? "").trim()

					const sourceID = seed ? `${MATRIKKELEN_ADAPTER_ID}-${seed}` : stableSourceID(MATRIKKELEN_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country,
						// Norwegian is the language of both jurisdictions' addresses,
						// and Bokmål is the written form Kartverket publishes.
						locale: `nb-${country}`,
						source: MATRIKKELEN_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: "CC-BY-4.0",
					}

					emitted++
				}
			} finally {
				if (cadastral > 0) {
					process.stderr.write(
						`  matrikkelen: ${cadastral} matrikkeladresse rows carry no street and were dropped, ${emitted} kept\n`
					)
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const matrikkelenAdapter = createMatrikkelenAdapter()
