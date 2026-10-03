/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ro-retea-scolara`: Romania's school network (`Rețea școlară`), the Ministry of Education's list of every
 * education unit for a school year, read for each unit's postal address.
 *
 * Input is the publisher's own workbook, one sheet named `Export`, as data.gov.ro serves it for the
 * dataset `69392a50-5750-4a54-90c1-d461de44da6d`. Three rows precede the header. The adapter finds the
 * header by its `Strada` cell rather than by position, because the preamble is a generation timestamp
 * whose length the publisher does not fix.
 *
 * ## Which fields make the address
 *
 * The sheet splits the address into `Strada`, `Numar`, `Cod postal` and `Localitate unitate`, so the
 * adapter splits no street line. Measured over the 2025–2026 edition's 18,022 units:
 *
 * - `Strada` is the street name as the school writes it, usually without the street-type word:
 *   `REPUBLICII`, `PRINCIPALA`, `Piața 1848`. 198 values begin with `STR.` and 247 with `CALEA`.
 *   The value is copied unchanged, because a street type the publisher did not write is not evidence.
 * - `Numar` holds the house number. `FN` (`fără număr`, "without number") and `-` state that the premise
 *   has none, on 601 and 180 units. Both are read as absent. A range such as `12-14` is a house number.
 * - `Cod postal` holds a six-digit Romanian postcode on 17,484 units. A value of any other length is
 *   left out of the row rather than refusing the row, because the address is complete without it.
 * - `Judet PJ` holds the county as a two-letter code. The row carries no region, because libaddressinput's
 *   Romanian layout places the county between postcode and locality, and this reader has no source for
 *   the county name in the form an address prints it.
 *
 * `Denumire lunga unitate`, the unit's full name, is the venue.
 *
 * ## Organizations only
 *
 * Every unit is a school, kindergarten, children's club, county inspectorate or similar public body, and
 * the sheet carries no natural person's address. The venue is the institution's name.
 *
 * ## Identity and license
 *
 * The row id is content-addressed over the aligned components. A school and its kindergarten often share
 * one address under two names, so they are two rows.
 *
 * data.gov.ro publishes the dataset under `CC-BY-4.0`, the license its CKAN record names for the
 * publisher `Ministerul Educației`. CC BY 4.0 requires credit, a link to the license and a statement that
 * changes were made, so every row records the license and {@linkcode RO_RETEA_SCOLARA_ATTRIBUTION} is the
 * credit the model card carries.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { PathBuilderLike } from "path-ts"
import { XLSXSpliterator, type XLSXCellValue } from "spliterator"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
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
export const RO_RETEA_SCOLARA_ADAPTER_ID = "ro-retea-scolara"

/**
 * The one jurisdiction this adapter emits.
 */
export const RO_RETEA_SCOLARA_COUNTRIES: readonly string[] = ["RO"]

/**
 * The license data.gov.ro names for the dataset.
 */
export const RO_RETEA_SCOLARA_LICENSE = "CC-BY-4.0"

/**
 * The credit CC BY 4.0 obliges.
 */
export const RO_RETEA_SCOLARA_ATTRIBUTION = "Ministerul Educației, Rețea școlară, via data.gov.ro"

/**
 * Why a unit did not become a row.
 */
export const ReteaScolaraRefusal = {
	/**
	 * The unit states no locality.
	 */
	LocalityAbsent: "row:locality-absent",
	/**
	 * The unit states neither a street nor a house number, so the locality alone would be a place name.
	 */
	PremiseAbsent: "row:premise-absent",
	/**
	 * The components do not render as a Romanian address line.
	 */
	Unrenderable: "row:unrenderable",
	/**
	 * Another unit already produced this exact row.
	 */
	Duplicate: "row:duplicate",
} as const

export type ReteaScolaraRefusal = (typeof ReteaScolaraRefusal)[keyof typeof ReteaScolaraRefusal]

/**
 * One unit's fields, keyed by the sheet's header.
 */
export type ReteaScolaraUnit = Readonly<Record<string, XLSXCellValue | undefined>>

export type ReteaScolaraReading = { readonly admitted: CanonicalRow } | { readonly refused: ReteaScolaraRefusal }

const NO_NUMBER: ReadonlySet<string> = new Set(["FN", "F.N.", "F/N", "-", "0", "SN", "S/N"])

const NUMBER_MARKER = /^(?:NR|NUM|NUMAR)\.?\s*/iu

const POSTCODE = /^\d{6}$/u

function cell(unit: ReteaScolaraUnit, header: string): string {
	return String(unit[header] ?? "")
		.replaceAll(/\s+/gu, " ")
		.trim()
}

/**
 * The house number a `Numar` cell states, or an empty string where it states none.
 */
export function readHouseNumber(value: string): string {
	const stripped = value.replace(NUMBER_MARKER, "").trim()

	return NO_NUMBER.has(stripped.toUpperCase()) ? "" : stripped
}

/**
 * Reads one unit into a row or the reason it is refused.
 */
export function readReteaScolaraUnit(unit: ReteaScolaraUnit): ReteaScolaraReading {
	const locality = cell(unit, "Localitate unitate")

	if (!locality) return { refused: ReteaScolaraRefusal.LocalityAbsent }

	const street = cell(unit, "Strada")
	const houseNumber = readHouseNumber(cell(unit, "Numar"))

	if (!street && !houseNumber) return { refused: ReteaScolaraRefusal.PremiseAbsent }

	const postcode = cell(unit, "Cod postal")
	const venue = cell(unit, "Denumire lunga unitate") || cell(unit, "Denumire scurta unitate")

	const components: CanonicalRow["components"] = {}

	if (venue) {
		components.venue = venue
	}

	if (street) {
		components.street = street
	}

	if (houseNumber) {
		components.house_number = houseNumber
	}

	if (POSTCODE.test(postcode)) {
		components.postcode = postcode
	}

	components.locality = locality

	const rendered = formatAddressRow(components, "RO", { singleLine: true })

	if (!rendered) return { refused: ReteaScolaraRefusal.Unrenderable }

	return {
		admitted: {
			raw: rendered.raw,
			components: rendered.components,
			country: "RO",
			locale: "ro-RO",
			source: RO_RETEA_SCOLARA_ADAPTER_ID,
			source_id: stableSourceID(RO_RETEA_SCOLARA_ADAPTER_ID, rendered.components),
			corpus_version: "",
			license: RO_RETEA_SCOLARA_LICENSE,
		},
	}
}

/**
 * The sheet's units keyed by its header, skipping the preamble above the row that holds `Strada`.
 */
export async function* readReteaScolaraUnits(inputPath: PathBuilderLike): AsyncGenerator<ReteaScolaraUnit> {
	let header: string[] | null = null

	for await (const row of XLSXSpliterator.fromAsync<XLSXCellValue[]>(inputPath.toString(), {
		mode: "array",
		header: false,
	})) {
		if (!header) {
			if (row.some((value) => value === "Strada")) {
				header = row.map((value) => String(value ?? "").trim())
			}

			continue
		}

		if (!row.some((value) => value !== null && value !== "")) continue

		yield Object.fromEntries(header.map((name, index) => [name, row[index]]))
	}

	if (!header) throw new Error(`${RO_RETEA_SCOLARA_ADAPTER_ID}: no header row with a "Strada" cell in ${inputPath}`)
}

export function createReteaScolaraAdapter(): CorpusAdapter {
	return {
		id: RO_RETEA_SCOLARA_ADAPTER_ID,
		defaultLicense: RO_RETEA_SCOLARA_LICENSE,
		addressRole: AddressRole.Facility,
		register: SourceRegister.ReteaScolara,
		surface: SurfaceOrigin.Rendered,
		description: "Romania's school network (Rețea școlară): the postal address of every education unit.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !RO_RETEA_SCOLARA_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(RO_RETEA_SCOLARA_ADAPTER_ID, RO_RETEA_SCOLARA_COUNTRIES, opts.country)
			}

			const seen = new Set<string>()
			let emitted = 0

			for await (const unit of readReteaScolaraUnits(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const reading = readReteaScolaraUnit(unit)

				if (!("admitted" in reading)) {
					countDropped(opts, reading.refused)

					continue
				}

				if (seen.has(reading.admitted.source_id)) {
					countDropped(opts, ReteaScolaraRefusal.Duplicate)

					continue
				}

				seen.add(reading.admitted.source_id)
				yield reading.admitted

				emitted++
			}
		},
	}
}

/**
 * The registered `ro-retea-scolara` adapter instance, built by {@linkcode createReteaScolaraAdapter}.
 */
export const reteaScolaraAdapter = createReteaScolaraAdapter()
