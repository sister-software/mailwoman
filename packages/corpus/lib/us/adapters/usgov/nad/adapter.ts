/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the US DOT National Address Database from the Parquet file `mailwoman corpus fetch nad` writes.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { US_STATE_ABBREVIATIONS } from "@mailwoman/codex/us/state"
import { isPresent } from "@mailwoman/core/objects"
import type { PathBuilderLike } from "path-ts"

import { rawTextDiscriminator } from "#adapters/record-id"
import { openParquetRowStream } from "#parquet/streams"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * The adapter stamps this id on every emitted row.
 */
export const USGOV_NAD_ADAPTER_ID = "usgov-nad"
/**
 * The license label on every emitted row, because US federal works are public domain under 17 U.S.C. § 105.
 */
export const USGOV_NAD_DEFAULT_LICENSE = "Public Domain"

/**
 * The all-zero UUID some NAD contributors publish in place of an identifier.
 */
export const NAD_PLACEHOLDER_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/u

/**
 * One NAD address point as the release publishes it, limited to the fields a reader here uses.
 *
 * The release's text file is read with every column as text.
 */
export interface NADRecord {
	OID_?: string | null
	UUID?: string | null
	AddNum_Pre?: string | null
	Add_Number?: number | string | null
	AddNum_Suf?: string | null
	AddNo_Full?: string | null
	St_PreMod?: string | null
	St_PreDir?: string | null
	St_PreTyp?: string | null
	St_PreSep?: string | null
	St_Name?: string | null
	St_PosTyp?: string | null
	St_PosDir?: string | null
	St_PosMod?: string | null
	StNam_Full?: string | null
	Building?: string | null
	Floor?: string | null
	Unit?: string | null
	Room?: string | null
	Seat?: string | null
	Addtl_Loc?: string | null
	SubAddress?: string | null
	LandmkName?: string | null
	County?: string | null
	Inc_Muni?: string | null
	Post_City?: string | null
	Census_Plc?: string | null
	Uninc_Comm?: string | null
	Nbrhd_Comm?: string | null
	NatAmArea?: string | null
	NatAmSub?: string | null
	Urbnztn_PR?: string | null
	PlaceOther?: string | null
	PlaceNmTyp?: string | null
	State?: string | null
	Zip_Code?: string | null
	Plus_4?: string | null
	AddAuth?: string | null
	Longitude?: string | null
	Latitude?: string | null
	Placement?: string | null
}

/**
 * The release columns {@link readNADRecords} projects, one per {@link NADRecord} field.
 */
export const NAD_RECORD_COLUMNS = [
	"OID_",
	"UUID",
	"AddNum_Pre",
	"Add_Number",
	"AddNum_Suf",
	"AddNo_Full",
	"St_PreMod",
	"St_PreDir",
	"St_PreTyp",
	"St_PreSep",
	"St_Name",
	"St_PosTyp",
	"St_PosDir",
	"St_PosMod",
	"StNam_Full",
	"Building",
	"Floor",
	"Unit",
	"Room",
	"Seat",
	"Addtl_Loc",
	"SubAddress",
	"LandmkName",
	"County",
	"Inc_Muni",
	"Post_City",
	"Census_Plc",
	"Uninc_Comm",
	"Nbrhd_Comm",
	"NatAmArea",
	"NatAmSub",
	"Urbnztn_PR",
	"PlaceOther",
	"PlaceNmTyp",
	"State",
	"Zip_Code",
	"Plus_4",
	"AddAuth",
	"Longitude",
	"Latitude",
	"Placement",
] as const satisfies ReadonlyArray<keyof NADRecord>

/**
 * A NAD UUID in the lower-case, unbraced form the FeatureServer published.
 *
 * The release text writes `{0002173C-ADA8-4421-ACF2-F9B6F12B52F0}`, and the
 * FeatureServer wrote `0002173c-ada8-4421-acf2-f9b6f12b52f0`.
 * Row ids are built from this form, so a record read from either keeps one
 * `source_id` and lands in one split.
 */
export function normalizeNADUUID(value: string | null | undefined): string | null {
	const unbraced = (value ?? "")
		.trim()
		.replace(/^\{(.*)\}$/u, "$1")
		.toLowerCase()

	return unbraced || null
}

/**
 * Streams the NAD records of one release Parquet file in file order, with each UUID normalized.
 *
 * @param where A DuckDB condition rows must satisfy, built with `escapeSQLString` for every literal.
 * @throws When the file lacks a column of {@link NAD_RECORD_COLUMNS}.
 */
export async function* readNADRecords(
	parquetPath: PathBuilderLike,
	options: { where?: string } = {}
): AsyncGenerator<NADRecord> {
	const rows = openParquetRowStream<NADRecord>(parquetPath, {
		columns: NAD_RECORD_COLUMNS,
		...(options.where ? { where: options.where } : {}),
	})

	for await (const row of rows) {
		yield { ...row, UUID: normalizeNADUUID(row.UUID) }
	}
}

/**
 * The USPS abbreviations a NAD row's `State` must match, taken from codex rather than restated.
 *
 * `US_STATE_ABBREVIATIONS` holds the 50 states, the District of Columbia and the five primary territories.
 * That's the set NAD publishes under, so this adapter keeps no list of its own.
 *
 * The two had identical membership when they were reconciled, at 56 entries each.
 */
const US_STATES_SET: ReadonlySet<string> = new Set(US_STATE_ABBREVIATIONS)

/**
 * A NAD row's unit as an address writes it: its `Building`, `Floor`, `Unit`
 * and `Room` parts in that order, or `null` when all four are empty.
 *
 * A publisher may write one designator into several columns, as New York writes `Apartment 2`
 * into both `Building` and `Unit`, so a part that repeats an earlier one is kept once.
 */
export function nadUnitText(record: NADRecord): string | null {
	const parts = new Set<string>()

	for (const part of [record.Building, record.Floor, record.Unit, record.Room]) {
		const trimmed = part?.trim()

		if (trimmed) {
			parts.add(trimmed)
		}
	}

	return parts.size ? [...parts].join(" ") : null
}

function nonEmpty(...values: Array<string | null | undefined>): string | null {
	for (const v of values) {
		const trimmed = (v ?? "").toString().trim()

		if (trimmed) return trimmed
	}

	return null
}

/**
 * The house number a NAD record states, read from its own four columns.
 *
 * NAD publishes `AddNo_Full` already assembled and its three parts beside it, so this prefers
 * the assembled column and falls back to joining `AddNum_Pre`, `Add_Number` and `AddNum_Suf`.
 * The shared `composeHouseNumber` in `#adapters/street/line` joins two columns with one separator.
 *
 * It suits a publisher that splits the number in two, and this reader joins three.
 */
export function nadHouseNumber(r: NADRecord): string | null {
	const full = (r.AddNo_Full ?? "").toString().trim()

	if (full) return full
	const num = r.Add_Number == null ? "" : String(r.Add_Number).trim()

	if (!num) return null
	const pre = (r.AddNum_Pre ?? "").toString().trim()
	const suf = (r.AddNum_Suf ?? "").toString().trim()

	return [pre, num, suf].filter(isPresent).join(" ").trim() || null
}

/**
 * A NAD street split into the prefix, name and suffix its structured columns state,
 * with the whole street beside them.
 */
export interface DecomposedNADStreet {
	prefix?: string
	street?: string
	suffix?: string
	full: string
}

/**
 * The street a NAD record states.
 *
 * Structured street fields take precedence.
 * If they're empty, `StNam_Full` supplies the whole street.
 */
export function decomposeNADStreet(r: NADRecord): DecomposedNADStreet | null {
	const name = (r.St_Name ?? "").toString().trim()

	if (name) {
		const preDir = (r.St_PreDir ?? "").toString().trim()
		const preTyp = (r.St_PreTyp ?? "").toString().trim()
		const preSep = (r.St_PreSep ?? "").toString().trim()
		const posTyp = (r.St_PosTyp ?? "").toString().trim()
		const posDir = (r.St_PosDir ?? "").toString().trim()
		const prefix = [preDir, preTyp, preSep].filter(isPresent).join(" ") || undefined
		const suffix = [posTyp, posDir].filter(isPresent).join(" ") || undefined
		const full = [prefix, name, suffix].filter(isPresent).join(" ")

		return { prefix, street: name, suffix, full }
	}

	const full = (r.StNam_Full ?? "").toString().trim()

	if (full) return { full, street: full }

	return null
}

/**
 * The NAD domain values that fill a place-name column without naming a place, lower-cased.
 */
const NAD_PLACEHOLDER_PLACE_NAMES: ReadonlySet<string> = new Set(["not stated", "unincorporated", "0"])

/**
 * The locality a NAD record states.
 *
 * The postal city comes first because it is the name that people write on mail.
 * NAD fills an unknown `Post_City` with the domain value `Not stated`
 * (99,998 rows of a 100,000-row Massachusetts sample and 11,713 of a Texas one), and an address
 * outside any municipality has `Inc_Muni` `Unincorporated` (the same 11,713 Texas rows).
 *
 * Another 23 rows of that Texas sample read `0`.
 * Each of these values counts as absent, and the next column supplies the place name.
 */
export function composeNADLocality(r: NADRecord): string | null {
	return nonEmpty(
		statedNADPlaceName(r.Post_City),
		statedNADPlaceName(r.Inc_Muni),
		statedNADPlaceName(r.Census_Plc),
		statedNADPlaceName(r.Uninc_Comm)
	)
}

/**
 * A NAD place-name column's value trimmed, or `null` when it is empty or a placeholder such as `Not stated`.
 */
export function statedNADPlaceName(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? ""

	return trimmed && !NAD_PLACEHOLDER_PLACE_NAMES.has(trimmed.toLowerCase()) ? trimmed : null
}

function composePostcode(r: NADRecord): string | null {
	const zip = (r.Zip_Code ?? "").toString().trim()

	if (!zip) return null
	const plus4 = (r.Plus_4 ?? "").toString().trim()

	return plus4 ? `${zip}-${plus4}` : zip
}

/**
 * Creates the NAD adapter.
 *
 * The adapter skips records without a US state code, locality, or ZIP code.
 * It also skips rows whose rendering keeps two or fewer components.
 */
export function createUsgovNADAdapter(): CorpusAdapter {
	return {
		id: USGOV_NAD_ADAPTER_ID,
		defaultLicense: USGOV_NAD_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.NationalAddressDatabase,
		surface: SurfaceOrigin.Rendered,
		description:
			"US DOT National Address Database — ~97M structured US address points (911-grade). Single largest US source.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-nad adapter: only US supported, got country=${opts.country}`)
			}

			let emitted = 0

			// The row stream closes its DuckDB connection when the loop exits early.
			for await (const record of readNADRecords(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const state = (record.State ?? "").trim().toUpperCase()

				if (!US_STATES_SET.has(state)) continue

				const locality = composeNADLocality(record)

				if (!locality) continue

				const postcode = composePostcode(record)

				if (!postcode) continue

				const decomposed = decomposeNADStreet(record)
				const houseNumber = nadHouseNumber(record)
				const venue = nonEmpty(record.LandmkName)
				const unit = nadUnitText(record)

				const components: CanonicalRow["components"] = {
					...(venue ? { venue } : {}),
					...(houseNumber ? { house_number: houseNumber } : {}),
					...(decomposed?.prefix ? { street_prefix: decomposed.prefix } : {}),
					...(decomposed?.street ? { street: decomposed.street } : {}),
					...(decomposed?.suffix ? { street_suffix: decomposed.suffix } : {}),
					...(unit ? { unit } : {}),
					locality,
					region: state,
					postcode,
				}

				const rendered = formatAddressRow(components, "US", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

				if (Object.keys(aligned).length <= 2) continue

				// NAD repeats a UUID across distinct addresses
				// (6804 Breed Street and 704 West Breed Street, CHILTON, WI share 79461b5e-…),
				// and 82 addresses share the all-zero placeholder UUID (#2894).
				// The id therefore adds a digest of the rendered address to the UUID.
				// Two points of one address stay one record, and two addresses under one UUID become two.
				const key = record.UUID && !NAD_PLACEHOLDER_UUID.test(record.UUID) ? record.UUID : record.OID_

				const sourceID = `${USGOV_NAD_ADAPTER_ID}-${key ?? `row${emitted}`}-${rawTextDiscriminator(raw)}`

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: USGOV_NAD_ADAPTER_ID,
					source_id: sourceID,
					license: USGOV_NAD_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The NAD adapter instance that the corpus builder registers.
 */
export const usgovNADAdapter = createUsgovNADAdapter()
