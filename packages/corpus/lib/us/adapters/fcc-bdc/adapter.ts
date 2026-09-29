/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fcc-bdc`: FCC Broadband Data Collection (BDC) adapter.
 *
 *   Reads BDC Fabric addresses from a prebuilt SQLite database.
 * 	 Note that Fabric IDs are managed by CostQuest and may be subject to licensing or usage restrictions.
 *
 *   Each row is keyed by `location_id` and includes:
 *   `address_primary`, `city`, `state`, `zip`, and `zip_suffix`.
 *
 *   This adapter does not download raw BDC files.
 *
 *   It converts each source row into one CanonicalRow by:
 *   - splitting `address_primary` into `house_number` + `street`
 *   - combining `zip` + `zip_suffix` into `postcode`
 *
 *   Rows are stamped with the source license: `"Public Domain"`.
 */

import type { BDCDatabase } from "@mailwoman/bdc/schema"
import { formatAddressRow } from "@mailwoman/codex/address-format"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { splitStreetLine } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"
import { lookupStateAbbreviation } from "#us/fips-state"

/**
 * Stable registry id for this adapter.
 */
export const FCC_BDC_ADAPTER_ID = "fcc-bdc"
/**
 * Default license stamped on emitted rows.
 */
export const FCC_BDC_DEFAULT_LICENSE = "Public Domain"

/**
 * SQLite row shape (one row per `location_id`).
 */
interface BdcLocationRow {
	location_id: number
	address_primary: string
	city: string
	state: string
	zip: string
	zip_suffix: string | null
}

/**
 * Build USPS postcode from `zip` and optional `zip_suffix`.
 * Handles both a 4-digit suffix and a full ZIP+4 value.
 *
 * - Bare 4-digit extension (`zip="94103"`, `zip_suffix="1234"`) → `"94103-1234"`
 * - Already-joined form (`zip_suffix="94103-1234"`) → returned as-is
 * - No suffix → bare `zip`
 *
 * Empty/whitespace suffix is treated as missing.
 */
export function buildPostcode(zip: string, suffix: string | null): string {
	const z = zip.trim()

	if (!z) return ""
	const s = suffix?.trim() ?? ""

	if (!s) return z

	if (s.includes("-")) return s

	return `${z}-${s}`
}

/**
 * Build the BDC corpus adapter.
 */
export function createFccBdcAdapter(): CorpusAdapter {
	return {
		id: FCC_BDC_ADAPTER_ID,
		defaultLicense: FCC_BDC_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.FCCBroadbandData,
		surface: SurfaceOrigin.Rendered,
		description: "FCC Broadband Data Collection — Fabric-derived BSL addresses (public-domain).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`fcc-bdc adapter: only US supported, got country=${opts.country}`)
			}

			const db = new DatabaseClient<BDCDatabase>(opts.inputPath, { readOnly: true })
			let emitted = 0

			try {
				const stmt = db.prepare(
					`SELECT location_id, address_primary, city, state, zip, zip_suffix
					 FROM bdc_locations
					 ORDER BY location_id`
				)

				for (const row of stmt.iterate() as IterableIterator<BdcLocationRow>) {
					if (opts.signal?.aborted) return

					if (opts.limit !== undefined && emitted >= opts.limit) return

					const split = splitStreetLine(row.address_primary ?? "")

					if (!split) continue
					const state = lookupStateAbbreviation(row.state)

					if (!state) continue
					const locality = row.city?.trim()

					if (!locality) continue
					const postcode = buildPostcode(row.zip ?? "", row.zip_suffix ?? null)

					if (!postcode) continue

					const components: CanonicalRow["components"] = {
						...(split.house_number ? { house_number: split.house_number } : {}),
						street: split.street,
						locality,
						region: state.abbreviation,
						postcode,
					}

					const rendered = formatAddressRow(components, "US", { singleLine: true })

					if (!rendered) continue

					const { raw, components: aligned } = rendered

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: FCC_BDC_ADAPTER_ID,
						source_id: `${FCC_BDC_ADAPTER_ID}-${row.location_id}`,
						corpus_version: "",
						license: FCC_BDC_DEFAULT_LICENSE,
					}

					emitted++
				}
			} finally {
				await db.destroy()
			}
		},
	}
}

/**
 * Default configured adapter instance.
 */
export const fccBdcAdapter = createFccBdcAdapter()
