/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ban`: Base Adresse Nationale CSV adapter, street-level over eleven jurisdictions.
 *
 * Input is a semicolon-separated CSV dump from `adresse.data.gouv.fr`. The adapter reads `numero`
 * as `house_number`, `rep` as a repetition index appended to it, `nom_voie` as `street`,
 * `code_postal` as `postcode`, and `nom_commune` as `locality`. BAN carries no region column, so
 * region is left to the wof-postalcode and wof-admin cross-reference at corpus build time.
 *
 * IGN publishes one file per INSEE department beside the whole-country extract, and the overseas
 * departments carry the same 23-column header as the metropolitan rows. A row's country is therefore
 * derived from `code_insee` rather than asserted by the caller, which reads the same whether the
 * input is one department's file or an extract spanning several.
 *
 * The official BAN is dual-licensed under Licence Ouverte 2.0 and ODbL.
 * This adapter elects Licence Ouverte 2.0. Its terms permit training with attribution.
 * It records that licence on every row. The model card must include BAN attribution.
 *
 * The adapter streams with `CSVSpliterator.fromAsync`, so a 25M-row file never sits in memory. It
 * honors `opts.limit` and `opts.signal`. `opts.country` is optional: when set it both rejects a
 * jurisdiction BAN does not publish and keeps only the rows of the one named.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { CSVSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
import { countryOfInseeCode, INSEE_COUNTRIES } from "#fr/insee-country"
import { decomposeFrStreet } from "#fr/street-decompose"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const BAN_ADAPTER_ID = "ban"

/**
 * Subset of BAN CSV columns the adapter consults.
 *
 * Everything else is ignored.
 * The explicit shape catches column-name drift early if BAN evolves its schema.
 */
interface BanRow {
	id: string
	numero: string
	rep: string
	nom_voie: string
	code_postal: string
	code_insee: string
	nom_commune: string
}

export function createBanAdapter(): CorpusAdapter {
	return {
		id: BAN_ADAPTER_ID,
		defaultLicense: "Licence Ouverte 2.0",
		addressRole: AddressRole.Premise,
		register: SourceRegister.BaseAdresseNationale,
		surface: SurfaceOrigin.Rendered,
		description:
			"Base Adresse Nationale: house-number-level street addresses for France and ten overseas jurisdictions.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !INSEE_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(BAN_ADAPTER_ID, INSEE_COUNTRIES, opts.country)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
				columnDelimiter: ";",
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<BanRow>) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const country = countryOfInseeCode(record.code_insee ?? "")

				// A caller that named one jurisdiction gets that jurisdiction's rows,
				// so one extract spanning several departments can be read once per country.
				if (opts.country && country !== opts.country) continue

				// BAN stores a repetition index ("bis", "ter", "quater") in `rep`,
				// which follows the number as a separate word.
				const house = composeHouseNumber(record.numero ?? "", record.rep ?? "", " ")
				const street = record.nom_voie ?? ""
				const postcode = record.code_postal ?? ""
				const locality = record.nom_commune ?? ""

				if (!street || !locality) continue

				if (!house && !postcode) continue

				const decomposed = decomposeFrStreet(street)

				const components: CanonicalRow["components"] = {}

				if (house) {
					components.house_number = house
				}

				if (decomposed.prefix) {
					components.street_prefix = decomposed.prefix
				}

				if (decomposed.street) {
					components.street = decomposed.street
				}

				if (postcode) {
					components.postcode = postcode
				}

				if (locality) {
					components.locality = locality
				}

				const rendered = formatAddressRow(components, country, { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				const sourceID = record.id ? `${BAN_ADAPTER_ID}-${record.id}` : stableSourceID(BAN_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country,
					// Every jurisdiction BAN publishes writes its addresses in French,
					// so the language is constant and the region carries the jurisdiction.
					locale: `fr-${country}`,
					source: BAN_ADAPTER_ID,
					source_id: sourceID,
					corpus_version: "",
					license: "Licence Ouverte 2.0",
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const banAdapter = createBanAdapter()
