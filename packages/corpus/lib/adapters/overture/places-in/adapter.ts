// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `overture-places-in`: the street addresses of Indian places in the Overture Maps places theme.
 *
 * Input is the parquet file `#tools/fetch/overture-places-in` copies out of one Overture release.
 * It holds each Indian place's first address as `freeform` (the street line),
 * `locality`, `region` and `postcode`, with the dataset Overture took the place from
 * (Microsoft, Meta, Foursquare, AllThePlaces, DAC, PinMeTo).
 *
 * ## The rendered order
 *
 * Each row renders through the IN layout in `@mailwoman/codex/address/layouts`.
 * The share `WRITTEN_LAYOUTS` records renders through the written order, with the state before the PIN.
 *
 * India Post's UPU description (`https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/indEn.pdf`,
 * 01/2013, sha256 `f8ac2ed37a59ecece8cd11e2ac5088411148b1e3d69304c118e655e275fa2a3e`) writes the
 * premise number, a comma and the street (`4, Amrita Shergill Road`, `32/1, 2nd Main Road`).
 * The sub-locality (`Jayanagar`), the locality, the state and the PIN
 * follow (`Bangalore / Karnataka / 560082`).
 *
 * A hash of the Overture id draws between the two orders, so a rebuild renders each place the same way.
 *
 * ## What a row holds
 *
 * `segmentINStreetLine` (`#in/street-line/segment`) labels the street line,
 * and keeps a line only where each part has one reading.
 * The place's own name is never read, because a Meta or Foursquare listing can be
 * a person's (`HDFC ERGO Insurance Agent: <name>`).
 *
 * A state is kept only where Who's On First or GeoNames holds it as one of India's
 * first-level divisions, and only in a written-out form.
 * AllThePlaces writes districts there (`Erode`, `Palakkad`), and DAC and Meta write
 * ISO 3166-2 suffixes (`MH`), which Indian addresses spell out.
 *
 * A PIN is six digits, and a locality is letters without a comma.
 *
 * ## License
 *
 * Overture's places theme is CDLA Permissive 2.0 for Meta, Microsoft, DAC and PinMeTo,
 * Apache 2.0 for Foursquare and CC0 1.0 for AllThePlaces, as the register's elected
 * decision for `us-geodata-aggregate-1` records.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { writtenLayoutForCountry } from "@mailwoman/codex/address/layouts"
import { foldName } from "@mailwoman/codex/names/normalize"
import { sha256Hex } from "@mailwoman/core/crypto/hash"
import { mulberry32 } from "@mailwoman/core/math/random"

import { type RegionNames, tryReadDefaultRegionNames } from "#build/region-names"
import { INStreetLineRefusal, isINSubProvince, segmentINStreetLine } from "#in/street-line/segment"
import { openParquetRowStream } from "#parquet/streams"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter, stamped as the `source` of every row it emits.
 */
const OVERTURE_PLACES_IN_ADAPTER_ID = "overture-places-in"

/**
 * The license stamped on each row: the places theme's license for the CDLA datasets.
 *
 * The register decision records the Apache 2.0 and CC0 datasets.
 */
const OVERTURE_PLACES_IN_DEFAULT_LICENSE = "CDLA-Permissive-2.0"

/**
 * One row of the snapshot `#tools/fetch/overture-places-in` writes.
 */
interface OverturePlaceINRecord {
	id: string
	freeform: string | null
	locality: string | null
	region: string | null
	postcode: string | null
}

/**
 * Why a record emitted no row: the street line's own refusals, and the fields beside it.
 */
const OverturePlaceINRefusal = {
	...INStreetLineRefusal,
	StreetLineAbsent: "street-line-absent",
	LocalityUnread: "locality-unread",
	PostcodeUnread: "postcode-unread",
} as const

type OverturePlaceINRefusal = (typeof OverturePlaceINRefusal)[keyof typeof OverturePlaceINRefusal]

/**
 * A PIN code as the address writes it: six digits, the first one to eight,
 * with an optional space after the third.
 */
const PIN = /^([1-8]\d{2})\s?(\d{3})$/u

/**
 * A locality written in letters, with the spaces, dots, hyphens and apostrophes a name holds.
 */
const LOCALITY = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u

/**
 * The longest region value read as an ISO 3166-2 suffix (`MH`, `UP`) rather than a state's written name.
 */
const MAX_SUBDIVISION_CODE_LENGTH = 3

/**
 * A uniform draw in `[0, 1)` fixed by the Overture id.
 */
function drawFor(id: string): number {
	return mulberry32(Number.parseInt(sha256Hex(id).slice(0, 8), 16))()
}

/**
 * Read one record into a row's components, or the reason it holds none.
 */
function readOverturePlaceIN(
	record: OverturePlaceINRecord,
	regionNames: Pick<RegionNames, "holds">
): { components: CanonicalRow["components"] } | { refused: OverturePlaceINRefusal } {
	const freeform = record.freeform?.trim()

	if (!freeform) return { refused: OverturePlaceINRefusal.StreetLineAbsent }

	const locality = record.locality?.trim() ?? ""

	if (!LOCALITY.test(locality) || isINSubProvince(locality)) return { refused: OverturePlaceINRefusal.LocalityUnread }

	const pin = PIN.exec(record.postcode?.trim() ?? "")

	if (!pin) return { refused: OverturePlaceINRefusal.PostcodeUnread }

	const postcode = `${pin[1]}${pin[2]}`
	const regionValue = record.region?.trim() ?? ""

	const region =
		regionValue.length > MAX_SUBDIVISION_CODE_LENGTH &&
		foldName(regionValue) !== foldName(locality) &&
		regionNames.holds("IN", regionValue)
			? regionValue
			: undefined

	const line = segmentINStreetLine(freeform, { locality, region: regionValue })

	if ("refused" in line) return { refused: line.refused }

	const { omitted: _omitted, ...parts } = line

	if (parts.dependent_locality && foldName(parts.dependent_locality) === foldName(locality)) {
		delete parts.dependent_locality
	}

	return {
		components: {
			...parts,
			locality,
			...(region ? { region } : {}),
			postcode,
		},
	}
}

/**
 * Render one record as a corpus row, in the postal or the written order its id draws,
 * or `null` when it holds none.
 */
function renderOverturePlaceIN(
	record: OverturePlaceINRecord,
	regionNames: Pick<RegionNames, "holds">
): CanonicalRow | null {
	const reading = readOverturePlaceIN(record, regionNames)

	if ("refused" in reading) return null

	const layout = writtenLayoutForCountry("IN", drawFor(record.id))
	const rendered = formatAddressRow(reading.components, "IN", { singleLine: true, ...(layout ? { layout } : {}) })

	if (!rendered) return null

	return {
		raw: rendered.raw,
		components: rendered.components,
		country: "IN",
		locale: "en-IN",
		source: OVERTURE_PLACES_IN_ADAPTER_ID,
		source_id: `${OVERTURE_PLACES_IN_ADAPTER_ID}-${record.id}`,
		license: OVERTURE_PLACES_IN_DEFAULT_LICENSE,
	}
}

/**
 * Options for {@link createOverturePlacesINAdapter}.
 */
export interface OverturePlacesINAdapterOptions {
	/**
	 * Reads India's first-level division names.
	 *
	 * Defaults to the Who's On First admin database with GeoNames' first-level names.
	 * The adapter refuses to run without one.
	 */
	regionNames?: () => Promise<Pick<RegionNames, "holds"> | null>
}

export function createOverturePlacesINAdapter(options: OverturePlacesINAdapterOptions = {}): CorpusAdapter {
	const loadRegionNames = options.regionNames ?? tryReadDefaultRegionNames

	return {
		id: OVERTURE_PLACES_IN_ADAPTER_ID,
		defaultLicense: OVERTURE_PLACES_IN_DEFAULT_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.Overture,
		surface: SurfaceOrigin.Rendered,
		description:
			"Overture Maps places in India — the street address of each place (CDLA Permissive 2.0 / Apache 2.0 / CC0), rendered in India Post's order.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			// A street-line reader for another country's Overture places would replace
			// this refusal. country-branch: the street-line reader and the PIN
			// and state checks follow India Post's conventions.
			if (opts.country && opts.country !== "IN") {
				throw new Error(`${OVERTURE_PLACES_IN_ADAPTER_ID} adapter: only IN supported, got country=${opts.country}`)
			}

			const regionNames = await loadRegionNames()

			if (!regionNames) {
				throw new Error(
					`${OVERTURE_PLACES_IN_ADAPTER_ID} adapter: the Who's On First admin database that holds India's states isn't on this host`
				)
			}

			let emitted = 0

			for await (const record of openParquetRowStream<OverturePlaceINRecord>(opts.inputPath, {
				columns: ["id", "freeform", "locality", "region", "postcode"],
			})) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const row = renderOverturePlaceIN(record, regionNames)

				if (!row) continue

				yield row

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const overturePlacesINAdapter = createOverturePlacesINAdapter()
