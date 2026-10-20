/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `llv-li`: the official index of building addresses of Liechtenstein, `Verzeichnis der
 * Gebäudeadressen`, which the Liechtensteinische Landesverwaltung publishes on
 * `service.geo.llv.li/download/` as one ZIP (`getfile.php?theme=officialAdress`).
 *
 * The ZIP holds `dataset.csv`, a shapefile of the same records and the license PDF. The CSV is
 * Windows-1252 (`Äussere Wiesen` reads `\xc4ussere Wiesen`), CRLF-terminated and `;`-separated, with no
 * quoting. The adapter reads `dataset.csv` from the ZIP, or from a path to the extracted CSV.
 *
 * The adapter reads `STN_NAME` as the street and `ADR_NUMBER` as the house number, including its
 * lower-case letter suffix (`12c`). It reads `ZIP_ZIP4` as the postcode and `ZIP_NAME` as the postal locality.
 * `COM_FOSNR` is the municipality's number and no column holds its name, so no region is emitted. The LI
 * layout prints no region in any case.
 *
 * `STATUS` reads `real` or `planned`. A planned address is one assigned to a building not yet built, so
 * the adapter refuses it. `OFFICIAL` reads `TRUE` or `FALSE`; an address the register marks as not
 * official is refused too, because its text is not the designation the municipality assigned.
 *
 * The publisher grants reproduction, redistribution, enrichment, editing, combination and commercial use
 * under its `ABI/OGD-Version 2 vom 5.2.2021` terms, on condition that the source
 * `Liechtensteinische Landesverwaltung` is stated and the terms are enclosed or linked. Every row
 * records that license.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { decodeBytes } from "@mailwoman/core/fs/streams"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { acceptPostcode } from "@mailwoman/postcode/country-formats"
import { resolvePath } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { present } from "#adapters/present"
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
export const LLV_LI_ADAPTER_ID = "llv-li"

/**
 * The Landesverwaltung's own terms, `ABI/OGD-Version 2 vom 5.2.2021`.
 * They have no SPDX identifier.
 */
export const LLV_LI_LICENSE = "LicenseRef-LI-ABI-OGD-2"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const LLV_LI_COUNTRIES: readonly string[] = ["LI"]

/**
 * The ZIP member that holds the address table.
 */
export const LLV_LI_MEMBER = "dataset.csv"

/**
 * The columns the adapter reads from `dataset.csv`.
 */
export interface LLVLiechtensteinRecord {
	ADR_EGAID: string
	STN_NAME: string
	ADR_NUMBER: string
	ZIP_ZIP4: string
	ZIP_NAME: string
	STATUS: string
	OFFICIAL: string
}

/**
 * Maps one record onto the components the corpus asserts, or returns null when the row is refused.
 *
 * Each refusal increments its reason in `dropped`.
 */
export function componentsForLLVRecord(
	record: LLVLiechtensteinRecord,
	dropped?: Pick<AdapterOptions, "dropped">
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}

	if (record.STATUS?.trim() !== "real") {
		countDropped(tally, record.STATUS?.trim() === "planned" ? "row:status-planned" : "row:status-unknown")

		return null
	}

	if (record.OFFICIAL?.trim().toUpperCase() !== "TRUE") {
		countDropped(tally, "row:not-official")

		return null
	}

	const street = present(record.STN_NAME)

	if (!street) {
		countDropped(tally, "row:no-street")

		return null
	}

	const number = present(record.ADR_NUMBER)

	if (!number) {
		countDropped(tally, "row:no-house-number")

		return null
	}

	const components: CanonicalRow["components"] = {
		street,
		house_number: number,
	}

	const postcode = present(record.ZIP_ZIP4)
	const matched = postcode ? acceptPostcode(postcode, "LI") : null

	if (matched) {
		components.postcode = matched
	} else if (postcode) {
		countDropped(tally, "component:postcode:not-country-format")
	}

	const locality = present(record.ZIP_NAME)

	if (locality) {
		components.locality = locality
	}

	if (!components.locality && !components.postcode) {
		countDropped(tally, "row:no-locality-or-postcode")

		return null
	}

	return components
}

/**
 * The bytes of `dataset.csv`, read from the publisher's ZIP or from the extracted file.
 *
 * The table is about 2 MB, so it is held whole.
 */
async function datasetBytes(inputPath: string): Promise<Buffer> {
	if (!inputPath.toLowerCase().endsWith(".zip")) return readLocalBuffer(inputPath)

	const chunks: Uint8Array[] = []

	for await (const chunk of readZipEntry(inputPath, LLV_LI_MEMBER)) {
		chunks.push(chunk)
	}

	return Buffer.concat(chunks)
}

export function createLLVLiechtensteinAdapter(): CorpusAdapter {
	return {
		id: LLV_LI_ADAPTER_ID,
		defaultLicense: LLV_LI_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.LiechtensteinGebaeudeadressen,
		surface: SurfaceOrigin.Rendered,
		description: "Verzeichnis der Gebäudeadressen (Liechtensteinische Landesverwaltung): national building addresses.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !LLV_LI_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(LLV_LI_ADAPTER_ID, LLV_LI_COUNTRIES, opts.country)
			}

			const text = decodeBytes(await datasetBytes(resolvePath(opts.inputPath).toString()), "windows-1252")

			const records = CSVSpliterator.from<LLVLiechtensteinRecord>(Buffer.from(text, "utf8"), {
				normalizeKeys: false,
				columnDelimiter: ";",
			})

			let emitted = 0

			for (const record of records) {
				if (opts.signal?.aborted) return

				if (typeof opts.limit === "number" && emitted >= opts.limit) return

				const components = componentsForLLVRecord(record, opts)

				if (!components) continue

				const rendered = formatAddressRow(components, "LI", {
					singleLine: true,
				})

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
					country: "LI",
					locale: "de-LI",
					source: LLV_LI_ADAPTER_ID,
					// `ADR_EGAID` is the federal address identifier, unique per row of the register.
					source_id: stableSourceIDFromParts(LLV_LI_ADAPTER_ID, {
						...aligned,
						egaid: record.ADR_EGAID ?? "",
					}),
					license: LLV_LI_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const llvLiechtensteinAdapter = createLLVLiechtensteinAdapter()
