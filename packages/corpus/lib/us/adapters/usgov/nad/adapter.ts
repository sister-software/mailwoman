/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the US DOT National Address Database from a directory of NDJSON files written by the NAD fetcher.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { US_STATE_ABBREVIATIONS } from "@mailwoman/codex/us/state"
import { tryParsingJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { resolvePathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

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
 * One NAD address point as the FeatureServer pages publish it, limited to the fields a reader here uses.
 */
export interface NADRecord {
	OBJECTID?: number
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
}

/**
 * The USPS abbreviations a NAD row's `State` must match, taken from codex rather than restated.
 *
 * `US_STATE_ABBREVIATIONS` holds the 50 states, the District of Columbia and the five primary territories.
 * That is the set NAD publishes under, so this adapter keeps no list of its own.
 *
 * The two had identical membership when they were reconciled, at 56 entries each.
 */
const US_STATES_SET: ReadonlySet<string> = new Set(US_STATE_ABBREVIATIONS)

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
 * NAD publishes `AddNo_Full` already assembled and the parts beside it, so this prefers the
 * assembled column and falls back to joining `AddNum_Pre`, `Add_Number` and `AddNum_Suf`.
 * The shared `composeHouseNumber` in `#adapters/street-line` joins exactly two columns with
 * one separator, so it fits a publisher that splits the number in two rather than in four.
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
 * If they are empty, `StNam_Full` supplies the whole street.
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
	const stated = (value: string | null | undefined) =>
		NAD_PLACEHOLDER_PLACE_NAMES.has(value?.trim().toLowerCase() ?? "") ? null : value

	return nonEmpty(stated(r.Post_City), stated(r.Inc_Muni), stated(r.Census_Plc), stated(r.Uninc_Comm))
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

			// The input must be a directory of NDJSON files.
			const files = await Globerator.files("ndjson", {
				cwd: opts.inputPath,
				absolute: false,
				recursive: false,
			}).toSorted()

			let emitted = 0
			outer: for (const file of files) {
				if (opts.signal?.aborted) break
				// The spliterator closes the file when the loop exits early.
				const lines = TextSpliterator.fromAsync(resolvePathBuilder(opts.inputPath, file))

				for await (const line of lines) {
					if (opts.signal?.aborted) break outer

					if (typeof opts.limit === "number" && emitted >= opts.limit) break outer

					if (!line) continue

					const record = tryParsingJSON<NADRecord>(line)

					if (!record) continue

					const state = (record.State ?? "").toString().trim().toUpperCase()

					if (!US_STATES_SET.has(state)) continue

					const locality = composeNADLocality(record)

					if (!locality) continue

					const postcode = composePostcode(record)

					if (!postcode) continue

					const decomposed = decomposeNADStreet(record)
					const houseNumber = nadHouseNumber(record)
					const venue = nonEmpty(record.LandmkName)
					const unit = nonEmpty(record.Unit, record.Building, record.Floor, record.Room)

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

					const sourceID = record.UUID
						? `${USGOV_NAD_ADAPTER_ID}-${record.UUID}`
						: `${USGOV_NAD_ADAPTER_ID}-${record.OBJECTID ?? `${file}:${emitted}`}`

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: USGOV_NAD_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: USGOV_NAD_DEFAULT_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * The NAD adapter instance that the corpus builder registers.
 */
export const usgovNADAdapter = createUsgovNADAdapter()
