/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the US DOT National Address Database from a directory of NDJSON files written by the NAD fetcher.
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { tryParsingJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { resolvePathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * The adapter id stamped on every emitted row.
 */
export const USGOV_NAD_ADAPTER_ID = "usgov-nad"
/**
 * The license label on every emitted row, because US federal works are public domain under 17 U.S.C. § 105.
 */
export const USGOV_NAD_DEFAULT_LICENSE = "Public Domain"

interface NADRecord {
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

const US_STATES_SET = new Set([
	"AL",
	"AK",
	"AZ",
	"AR",
	"CA",
	"CO",
	"CT",
	"DE",
	"DC",
	"FL",
	"GA",
	"HI",
	"ID",
	"IL",
	"IN",
	"IA",
	"KS",
	"KY",
	"LA",
	"ME",
	"MD",
	"MA",
	"MI",
	"MN",
	"MS",
	"MO",
	"MT",
	"NE",
	"NV",
	"NH",
	"NJ",
	"NM",
	"NY",
	"NC",
	"ND",
	"OH",
	"OK",
	"OR",
	"PA",
	"RI",
	"SC",
	"SD",
	"TN",
	"TX",
	"UT",
	"VT",
	"VA",
	"WA",
	"WV",
	"WI",
	"WY",
	// NAD also covers these territories.
	"PR",
	"GU",
	"VI",
	"AS",
	"MP",
])

function nonEmpty(...values: Array<string | null | undefined>): string | undefined {
	for (const v of values) {
		const trimmed = (v ?? "").toString().trim()

		if (trimmed) return trimmed
	}

	return undefined
}

function composeHouseNumber(r: NADRecord): string | undefined {
	const full = (r.AddNo_Full ?? "").toString().trim()

	if (full) return full
	const num = r.Add_Number == null ? "" : String(r.Add_Number).trim()

	if (!num) return undefined
	const pre = (r.AddNum_Pre ?? "").toString().trim()
	const suf = (r.AddNum_Suf ?? "").toString().trim()

	return [pre, num, suf].filter(isPresent).join(" ").trim() || undefined
}

interface DecomposedNADStreet {
	prefix?: string
	street?: string
	suffix?: string
	full: string
}

// The structured street fields take precedence, and `StNam_Full` becomes the whole street when they are empty.
function decomposeNADStreet(r: NADRecord): DecomposedNADStreet | undefined {
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

	return undefined
}

// The postal city comes first because it is the name that people write on mail.
function composeLocality(r: NADRecord): string | undefined {
	return nonEmpty(r.Post_City, r.Inc_Muni, r.Census_Plc, r.Uninc_Comm)
}

function composePostcode(r: NADRecord): string | undefined {
	const zip = (r.Zip_Code ?? "").toString().trim()

	if (!zip) return undefined
	const plus4 = (r.Plus_4 ?? "").toString().trim()

	return plus4 ? `${zip}-${plus4}` : zip
}

/**
 * Creates the NAD adapter.
 *
 * The adapter skips records without a US state code, a locality or a ZIP code,
 * and rows whose rendering keeps two or fewer components.
 */
export function createUsgovNADAdapter(): CorpusAdapter {
	return {
		id: USGOV_NAD_ADAPTER_ID,
		defaultLicense: USGOV_NAD_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.NationalAddressDatabase,
		surface: SurfaceOrigin.Attested,
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

					if (opts.limit !== undefined && emitted >= opts.limit) break outer

					if (!line) continue

					const record = tryParsingJSON<NADRecord>(line)

					if (record === null) continue

					const state = (record.State ?? "").toString().trim().toUpperCase()

					if (!US_STATES_SET.has(state)) continue

					const locality = composeLocality(record)

					if (!locality) continue

					const postcode = composePostcode(record)

					if (!postcode) continue

					const decomposed = decomposeNADStreet(record)
					const houseNumber = composeHouseNumber(record)
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
