/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read per-country GeoNames postal dumps and emit postcode-first locality variants. Each row
 *   contains place and region names inline. The adapter is intended for non-US countries and emits
 *   CC-BY-4.0 rows.
 */

import { componentsPresentIn } from "@mailwoman/codex/address-format"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"

import { stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry ID stamped on rows from this source.
 */
export const GEONAMES_POSTAL_ADAPTER_ID = "geonames-postal"
/**
 * License attached to emitted rows.
 */
export const GEONAMES_POSTAL_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * Zero-based GeoNames postal-dump columns.
 *
 * Coordinates identify the postcode, not necessarily the locality.
 */
export const GEONAMES_POSTAL_COLUMNS = {
	country: 0,
	postcode: 1,
	place: 2,
	admin1Name: 3,
	admin2Name: 5,
	latitude: 9,
	longitude: 10,
} as const

export function createGeonamesPostalAdapter(): CorpusAdapter {
	return {
		id: GEONAMES_POSTAL_ADAPTER_ID,
		defaultLicense: GEONAMES_POSTAL_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.GeoNamesPostal,
		surface: SurfaceOrigin.Attested,
		description:
			"GeoNames postcodes (CC-BY-4.0) — multi-locale postcode→locality→region, names inline; international postcode-first order.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			// The dump has no header row.
			const rows = readUnquotedTSV(opts.inputPath)

			let emitted = 0

			for await (const rec of rows) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const cc = (rec[GEONAMES_POSTAL_COLUMNS.country] ?? "").trim()

				if (!cc) continue

				if (opts.country && cc !== opts.country) continue

				const postcode = (rec[GEONAMES_POSTAL_COLUMNS.postcode] ?? "").trim()
				const locality = (rec[GEONAMES_POSTAL_COLUMNS.place] ?? "").trim()

				if (!postcode || !locality) continue
				const region = (rec[GEONAMES_POSTAL_COLUMNS.admin1Name] ?? "").trim()

				// Skip the region variant when it merely repeats the locality.
				const variants: Array<{ slot: string; comp: CanonicalRow["components"]; raw: string }> = [
					{ slot: "pl", comp: { postcode, locality }, raw: `${postcode} ${locality}` },
				]

				if (region && region.toLowerCase() !== locality.toLowerCase()) {
					variants.push({
						slot: "plr",
						comp: { postcode, locality, region },
						raw: `${postcode} ${locality}, ${region}`,
					})
				}

				for (const v of variants) {
					if (opts.limit !== undefined && emitted >= opts.limit) break
					const aligned = componentsPresentIn(v.comp, v.raw)

					if (Object.keys(aligned).length < 2) continue

					yield {
						raw: v.raw,
						components: aligned,
						country: cc,
						source: GEONAMES_POSTAL_ADAPTER_ID,
						source_id: `${stableSourceID(GEONAMES_POSTAL_ADAPTER_ID, aligned)}-${v.slot}`,
						corpus_version: "",
						license: GEONAMES_POSTAL_DEFAULT_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * Adapter instance registered with the corpus builder.
 */
export const geonamesPostalAdapter = createGeonamesPostalAdapter()
