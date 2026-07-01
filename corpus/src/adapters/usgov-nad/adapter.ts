/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-nad`: US DOT National Address Database — ~97M structured address-point records.
 *
 *   The single largest US address source available — federal aggregation of state + local 911-grade
 *   address points (every addressable location). Compared to TIGER ADDRFEAT (~20M segment-level, no
 *   city/locality) and NPPES (~7M provider-centric venues), NAD covers the entire residential +
 *   commercial address space with full structured components.
 *
 *   The adapter consumes NDJSON shards produced by `fetch-nad.ts`'s featureserver mode (operator
 *   pre-downloads via `npx tsx packages/corpus/scripts/fetch-nad.ts`). Each shard is per-OID-range
 *   `oids_<start>-<end>.ndjson` with a sibling `.manifest.json`. Adapter iterates every `.ndjson`
 *   in the input directory, skipping the `quarantined-bash-bug/` subdir (legacy of the bash-
 *   fetcher's silent-page-failure bug).
 *
 *   Field mapping (NAD v9 → CanonicalRow components):
 *
 *   - House_number: `AddNo_Full` (pre-composed); falls back to AddNum_Pre + Add_Number + AddNum_Suf
 *   - Street: `StNam_Full` (pre-composed); falls back to St_PreDir + St_PreTyp + St_Name + St_PosTyp
 *
 *       - St_PosDir + St_PosMod composition
 *   - Locality: `Post_City` > `Inc_Muni` > `Census_Plc` > `Uninc_Comm` (first non-empty)
 *   - Region: `State` (2-char USPS code, including territories: PR, GU, VI, AS, MP)
 *   - Postcode: `Zip_Code` + `Plus_4` (joined as `XXXXX-NNNN` when both present)
 *   - Venue: `LandmkName` (typically a park, school, hospital, named facility — when present)
 *
 *   License: stamped `"Public Domain"` per 17 U.S.C. § 105 (US federal works).
 */

import { createReadStream } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const USGOV_NAD_ADAPTER_ID = "usgov-nad"
export const USGOV_NAD_DEFAULT_LICENSE = "Public Domain"

interface NADRecord {
	OBJECTID?: number
	UUID?: string | null
	// House number
	AddNum_Pre?: string | null
	Add_Number?: number | string | null
	AddNum_Suf?: string | null
	AddNo_Full?: string | null
	// Street parts
	St_PreMod?: string | null
	St_PreDir?: string | null
	St_PreTyp?: string | null
	St_PreSep?: string | null
	St_Name?: string | null
	St_PosTyp?: string | null
	St_PosDir?: string | null
	St_PosMod?: string | null
	StNam_Full?: string | null
	// Sub-address (carried as part of street for now; Phase 1 has no unit/floor labels)
	Building?: string | null
	Floor?: string | null
	Unit?: string | null
	Room?: string | null
	Seat?: string | null
	Addtl_Loc?: string | null
	SubAddress?: string | null
	// Landmark / venue
	LandmkName?: string | null
	// Locality alternates (we prefer Post_City for what a human would type)
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
	// State + ZIP
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
	// Territories that ship in NAD
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

	return [pre, num, suf].filter(Boolean).join(" ").trim() || undefined
}

interface DecomposedNADStreet {
	prefix?: string
	street?: string
	suffix?: string
	full: string
}

function decomposeNADStreet(r: NADRecord): DecomposedNADStreet | undefined {
	const name = (r.St_Name ?? "").toString().trim()

	if (name) {
		const preDir = (r.St_PreDir ?? "").toString().trim()
		const preTyp = (r.St_PreTyp ?? "").toString().trim()
		const preSep = (r.St_PreSep ?? "").toString().trim()
		const posTyp = (r.St_PosTyp ?? "").toString().trim()
		const posDir = (r.St_PosDir ?? "").toString().trim()
		const prefix = [preDir, preTyp, preSep].filter(Boolean).join(" ") || undefined
		const suffix = [posTyp, posDir].filter(Boolean).join(" ") || undefined
		const full = [prefix, name, suffix].filter(Boolean).join(" ")

		return { prefix, street: name, suffix, full }
	}
	const full = (r.StNam_Full ?? "").toString().trim()

	if (full) return { full, street: full }

	return undefined
}

function composeLocality(r: NADRecord): string | undefined {
	return nonEmpty(r.Post_City, r.Inc_Muni, r.Census_Plc, r.Uninc_Comm)
}

function composePostcode(r: NADRecord): string | undefined {
	const zip = (r.Zip_Code ?? "").toString().trim()

	if (!zip) return undefined
	const plus4 = (r.Plus_4 ?? "").toString().trim()

	return plus4 ? `${zip}-${plus4}` : zip
}

function composeRaw(parts: {
	venue?: string
	houseNumber?: string
	street?: string
	unit?: string
	locality: string
	region: string
	postcode: string
}): string {
	const streetLine = [parts.houseNumber, parts.street, parts.unit].filter(Boolean).join(" ").trim()
	const tail = `${parts.locality}, ${parts.region} ${parts.postcode}`

	return [parts.venue, streetLine || undefined, tail].filter(Boolean).join(", ")
}

export function createUsgovNADAdapter(): CorpusAdapter {
	return {
		id: USGOV_NAD_ADAPTER_ID,
		defaultLicense: USGOV_NAD_DEFAULT_LICENSE,
		description:
			"US DOT National Address Database — ~97M structured US address points (911-grade). Single largest US source.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-nad adapter: only US supported, got country=${opts.country}`)
			}

			// inputPath is a directory of NDJSON shards (per fetch-nad.ts featureserver output).
			// Single-file inputs (e.g. a bulk-extracted CSV) are not currently supported — the
			// featureserver shard pattern is the primary distribution.
			const entries = await readdir(opts.inputPath)
			const shards = entries.filter((n) => n.endsWith(".ndjson")).sort()

			let emitted = 0
			outer: for (const shard of shards) {
				if (opts.signal?.aborted) break
				const stream = createReadStream(join(opts.inputPath, shard), { encoding: "utf8" })
				const rl = createInterface({ input: stream, crlfDelay: Infinity })

				try {
					for await (const line of rl) {
						if (opts.signal?.aborted) break outer

						if (opts.limit !== undefined && emitted >= opts.limit) break outer

						if (!line) continue

						let record: NADRecord

						try {
							record = JSON.parse(line) as NADRecord
						} catch {
							continue // malformed line — skip silently
						}

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

						const raw = composeRaw({
							venue,
							houseNumber,
							street: decomposed?.full,
							unit,
							locality,
							region: state,
							postcode,
						})

						if (!raw) continue

						const aligned = reconcileComponents(components, raw)

						if (Object.keys(aligned).length <= 2) continue

						const sourceId = record.UUID
							? `${USGOV_NAD_ADAPTER_ID}-${record.UUID}`
							: `${USGOV_NAD_ADAPTER_ID}-${record.OBJECTID ?? `${shard}:${emitted}`}`

						yield {
							raw,
							components: aligned,
							country: "US",
							locale: "en-US",
							source: USGOV_NAD_ADAPTER_ID,
							source_id: sourceId,
							corpus_version: "",
							license: USGOV_NAD_DEFAULT_LICENSE,
						}
						emitted++
					}
				} finally {
					rl.close()
					stream.destroy()
				}
			}
		},
	}
}

export const usgovNADAdapter = createUsgovNADAdapter()
