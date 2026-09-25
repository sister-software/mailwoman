/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads a per-country GeoNames postal dump and emits postcode-first locality rows. Each dump row carries its place and
 *   region names inline.
 */

import { componentsPresentIn } from "@mailwoman/codex/address-format"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"

import { stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * The source ID on rows from this adapter.
 */
export const GEONAMES_POSTAL_ADAPTER_ID = "geonames-postal"
/**
 * The license on rows from this adapter.
 */
export const GEONAMES_POSTAL_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * Zero-based column indices in a GeoNames postal dump.
 *
 * The coordinates locate the postcode, which may differ from the locality's position.
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

/**
 * Creates the GeoNames postal adapter.
 */
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

				// The region row is skipped when the region name equals the locality name.
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
 * The adapter instance registered with the corpus builder.
 */
export const geonamesPostalAdapter = createGeonamesPostalAdapter()
