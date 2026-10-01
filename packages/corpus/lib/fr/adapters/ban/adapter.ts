/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ban`: Base Adresse Nationale CSV adapter (FR street-level).
 *
 * Input is a semicolon-separated CSV dump from `adresse.data.gouv.fr`. The adapter reads `numero`
 * as `house_number`, `rep` as a repetition index appended to it, `nom_voie` as `street`,
 * `code_postal` as `postcode`, and `nom_commune` as `locality`. BAN has no region and no
 * country. The adapter stamps `country: "FR"` on every row and leaves region to the
 * wof-postalcode and wof-admin cross-reference at corpus build time.
 *
 * The official BAN is dual-licensed under Licence Ouverte 2.0 and ODbL.
 * This adapter elects Licence Ouverte 2.0. Its terms permit training with attribution.
 * It records that licence on every row. The model card must include BAN attribution.
 *
 * The adapter streams with `CSVSpliterator.fromAsync`, so a 25M-row file never sits in memory. It
 * honors `opts.limit`, `opts.signal`, and `opts.country` (which errors when country is not FR).
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
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
	nom_commune: string
}

/**
 * Compose `house_number` from `numero` + `rep`.
 *
 * BAN uses `rep` for repetition indices ("bis", "ter", "quater") that follow the house number.
 * Result: `"10 bis"`, `"45"`, etc.
 */
function composeHouseNumber(numero: string, rep: string): string {
	const n = numero.trim()
	const r = rep.trim()

	if (!n) return ""

	return r ? `${n} ${r}` : n
}

export function createBanAdapter(): CorpusAdapter {
	return {
		id: BAN_ADAPTER_ID,
		defaultLicense: "Licence Ouverte 2.0",
		addressRole: AddressRole.Premise,
		register: SourceRegister.BaseAdresseNationale,
		surface: SurfaceOrigin.Rendered,
		description: "Base Adresse Nationale (FR): house-number-level street addresses (~25M rows).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "FR") {
				throw new Error(`ban adapter: only FR supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
				columnDelimiter: ";",
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<BanRow>) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const house = composeHouseNumber(record.numero ?? "", record.rep ?? "")
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

				const rendered = formatAddressRow(components, "FR", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				const sourceID = record.id ? `${BAN_ADAPTER_ID}-${record.id}` : stableSourceID(BAN_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "FR",
					locale: "fr-FR",
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
