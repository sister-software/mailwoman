/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fcc-bdc`: FCC Broadband Data Collection (BDC) — Fabric-derived location consumer.
 *
 *   The first member of Phase 1.6's "adversarial sources" class. BDC ships the public-domain US
 *   broadband-serviceable-location (BSL) fabric: ~120M addresses keyed by stable `location_id`,
 *   carrying `address_primary` + `city` + `state` + `zip` + `zip_suffix`. Compared to the clean
 *   gazetteer rows from WOF / TIGER / BAN, BDC carries the chaos of address data that has passed
 *   through several layers of human entry + automated geocoding + revision: abbreviation drift,
 *   inconsistent unit designators, "RR" / "HC" / "PSC" rural-route shapes, embedded apartment /
 *   suite numbers that did not survive the address parser cleanly. This is the highest-signal,
 *   hardest-to-normalize address corpus in the federal public-domain catalog.
 *
 *   Following the `tiger` / `wof-admin` pattern, this adapter consumes a SQLite database the operator
 *   pre-builds via the isp-nexus BDC ETL (`/srv/isp-nexus/sync/fcc/bdc/`) or any equivalent
 *   host-side pipeline. The mailwoman side does not download or parse the raw CSV/ZIP distribution
 *   directly — that keeps the adapter narrow and the BDC ingest pluggable.
 *
 *   The SQLite schema is documented in README.md and modeled after `NTIARecord`
 *   (`isp-nexus/fcc/bdc/data-collection.ts`): one row per `location_id`. The adapter splits
 *   `address_primary` into `house_number` (leading numeric prefix, if any) + `street` (everything
 *   after), and combines `zip` + `zip_suffix` into the canonical USPS `postcode` slot.
 *
 *   One CanonicalRow per fabric record. Unlike `tiger` (multiple postcode variants per segment) or
 *   `wof-admin` (multiple hierarchy variants per place), BDC records already represent fully
 *   specified addresses; no fan-out is warranted. Adversarial composition (Phase 1.6 §2.1) is the
 *   mechanism for deriving multiple training rows per BDC record.
 *
 *   License: stamped `"Public Domain"` per the BDC fabric's US federal-government distribution terms.
 *   The CostQuest Fabric source data has its own license; consumers who substitute that path should
 *   re-stamp accordingly.
 */

import { DatabaseSync } from "node:sqlite"

import { lookupStateAbbreviation } from "../../codex/us-fips-state.ts"
import { formatAddress, reconcileComponents } from "../../format.ts"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.ts"

export const FCC_BDC_ADAPTER_ID = "fcc-bdc"
export const FCC_BDC_DEFAULT_LICENSE = "Public Domain"

/** SQLite row shape — one row per BSL `location_id`. Columns mirror NTIARecord. */
interface BdcLocationRow {
	location_id: number
	address_primary: string
	city: string
	state: string
	zip: string
	zip_suffix: string | null
}

/**
 * Split `address_primary` into a `(house_number, street)` pair.
 *
 * BDC's `address_primary` follows USPS Publication 28 conventions but with hand-entry drift. The canonical
 * leading-digit prefix is the house number (`"123 Main St"`, `"6450 W Indian School Rd"`, even hyphenated forms `"40-12
 * Bell Blvd"`). Anything that doesn't match the prefix shape (`"PO Box 1234"`, `"RR 2 Box 67"`, `"HC 1"`) is left as a
 * single `street` value — the model sees the original surface form, and downstream classifiers/po-box handling can pick
 * it up.
 *
 * The regex tolerates one trailing letter (`"123A Main St"`) and an optional hyphenated half (`"40-12"`) which is
 * common in NYC + suburban garden-apartment numbering.
 */
const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/

interface SplitAddress {
	house_number?: string
	street: string
}

export function splitAddressPrimary(address: string): SplitAddress | null {
	const trimmed = address.trim()

	if (!trimmed) return null
	const match = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (match) {
		return { house_number: match[1], street: match[2]!.trim() }
	}

	return { street: trimmed }
}

/**
 * Combine `zip` + optional `zip_suffix` into the canonical USPS postcode surface form.
 *
 * NTIARecord doc is ambiguous about whether `zip_suffix` is the 4-digit extension alone or the full ZIP+4 string. This
 * handles both:
 *
 * - Bare 4-digit extension (`zip="94103"`, `zip_suffix="1234"`) → `"94103-1234"`
 * - Already-joined form (`zip_suffix="94103-1234"`) → returned as-is
 * - No suffix → bare `zip`
 *
 * Empty / whitespace-only suffix is treated as missing.
 */
export function buildPostcode(zip: string, suffix: string | null): string {
	const z = zip.trim()

	if (!z) return ""
	const s = suffix?.trim() ?? ""

	if (!s) return z

	if (s.includes("-")) return s

	return `${z}-${s}`
}

/** Build a BDC adapter. Pure factory so multiple instances can be created in tests. */
export function createFccBdcAdapter(): CorpusAdapter {
	return {
		id: FCC_BDC_ADAPTER_ID,
		defaultLicense: FCC_BDC_DEFAULT_LICENSE,
		description:
			"FCC Broadband Data Collection — Fabric-derived BSL addresses (public-domain); SQLite DB the operator builds via the isp-nexus BDC ETL.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`fcc-bdc adapter: only US supported, got country=${opts.country}`)
			}

			const db = new DatabaseSync(opts.inputPath, { readOnly: true })
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

					const split = splitAddressPrimary(row.address_primary ?? "")

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

					const raw = formatAddress(components, "US", { separator: ", " })

					if (!raw) continue
					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length === 0) continue

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
				db.close()
			}
		},
	}
}

export const fccBdcAdapter = createFccBdcAdapter()
