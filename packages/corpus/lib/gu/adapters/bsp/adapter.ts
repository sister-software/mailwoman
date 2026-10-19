/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `bsp-gu`: the address points of Guam, which the Bureau of Statistics & Plans GIS publishes on the
 * Government of Guam GISWEB Portal as the ArcGIS layer `Address_Point_(Public_View)`.
 *
 * The input is the layer's GeoJSON query pages, one file or a directory of them. The adapter reads
 * `HOUSE_NUM` as the house number, `PRE_DIR` as the street prefix, `STREETNAME` as the street (or the
 * assembled `FullRdNm` when `STREETNAME` is blank), `STR_TYPE` as the street suffix, `UNIT` as the unit
 * and `CITY` (or `PLACENAME` when `CITY` is blank) as the locality. Route roads read `ROUTE 10` with the
 * type `HWY`, which is how the layer's own `FullRdNm` writes them.
 *
 * The layer carries no postcode: its NG911 `Post_Code` column is blank on every feature.
 *
 * `HOUSE_NUM` sometimes pairs the number with a building-permit number (`120 / B19000483`); the number is
 * kept and the permit dropped. `CITY` writes Guam's villages with Chamorro and English spellings
 * (`HAGÅTÑA`, `HAGATNA`; `INARAJAN`, `INALAHAN`) and with typing slips (`BARRIGDAA`, `MANGIL.AO`), so a
 * value is kept only when each of its parts is a village, or a community the villages contain,
 * listed in {@link GUAM_PLACE_NAMES}. A road written `(OFF OF) ROUTE 4A HWY` locates a point near a road
 * rather than on it, and a street naming two roads (`AGUILAR RD / RT 17`) states no single street, so both
 * are refused.
 *
 * The layer states no license. Under the United States position in `packages/corpus/lib/us/AGENTS.md`
 * (Feist), a US public body's address file published without terms restricting its use is elected,
 * and the rows carry the label the US public-body adapters use.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { foldToken } from "@mailwoman/codex/normalize"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { parseJSONStrict } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
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
export const BSP_GU_ADAPTER_ID = "bsp-gu"

/**
 * The label every row carries, matching the US public-body adapters elected under the Feist reading.
 */
export const BSP_GU_LICENSE = "Public Domain"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 */
export const BSP_GU_COUNTRIES: readonly string[] = ["GU"]

/**
 * The feature properties the adapter reads from the layer.
 */
export interface GuamAddressPointRecord {
	FID?: number | null
	HOUSE_NUM?: string | null
	PRE_DIR?: string | null
	STREETNAME?: string | null
	STR_TYPE?: string | null
	FullRdNm?: string | null
	UNIT?: string | null
	CITY?: string | null
	PLACENAME?: string | null
}

interface GuamFeatureCollection {
	features?: Array<{
		properties?: GuamAddressPointRecord | null
		geometry?: { coordinates?: readonly number[] } | null
	}>
}

/**
 * A value with its whitespace collapsed, or null when the layer leaves it blank.
 * The layer writes an absent string as a single space.
 */
function present(value: string | number | null | undefined): string | null {
	const collapsed = value == null ? "" : String(value).replaceAll(/\s+/gu, " ").trim()

	return collapsed || null
}

/**
 * Upper-cased, with diacritics removed, so `HAGÅTÑA` and `Hagatna` compare equal.
 */
function upperFold(value: string): string {
	return foldToken(value).toUpperCase()
}

/**
 * Guam's nineteen villages under each name the layer writes for them,
 * and the communities within a village that `CITY` names on its own
 * (Tumon and Harmon in Tamuning, Ipan in Talofofo, Paasan in Agana Heights, Anigua in Hagåtña), folded.
 */
export const GUAM_PLACE_NAMES: ReadonlySet<string> = new Set([
	"AGANA HEIGHTS",
	"PAASAN",
	"AGAT",
	"HAGAT",
	"ASAN",
	"MAINA",
	"ASAN MAINA",
	"BARRIGADA",
	"BARRIGADA HEIGHTS",
	"CHALAN PAGO",
	"ORDOT",
	"CHALAN PAGO ORDOT",
	"DEDEDO",
	"HAGATNA",
	"AGANA",
	"ANIGUA",
	"INARAJAN",
	"INALAHAN",
	"INALAJAN",
	"MANGILAO",
	"MERIZO",
	"MALESSO",
	"MONGMONG",
	"TOTO",
	"MAITE",
	"MONGMONG TOTO MAITE",
	"PITI",
	"SANTA RITA",
	"SINAJANA",
	"TALOFOFO",
	"IPAN",
	"TAMUNING",
	"TUMON",
	"HARMON",
	"UMATAC",
	"HUMATAC",
	"YIGO",
	"YONA",
])

/**
 * Whether every part of a place value, split at commas, slashes, hyphens and parentheses,
 * is a listed place: `CHALAN PAGO - ORDOT` and `AGANA HEIGHTS (PAASAN)` are, `RADIO, BARRIGADA` is not.
 */
export function isGuamPlaceName(value: string): boolean {
	const parts = upperFold(value)
		.split(/[,/()-]/u)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)

	return parts.length > 0 && parts.every((part) => GUAM_PLACE_NAMES.has(part))
}

/**
 * A house number: digits, an optional hyphenated half, and an optional letter written
 * against the number or after a space (`120`, `99-12`, `231A`, `155 A`).
 */
const HOUSE_NUMBER = /^\d+(?:-\d+)?(?: ?[A-Z])?$/u

/**
 * A Guam building-permit number, written beside a house number in `HOUSE_NUM` (`B19000483`, `B22-450`).
 */
const PERMIT_NUMBER = /^[A-Z]{1,2}\d{2}-?\d{3,}$/iu

/**
 * The house number `HOUSE_NUM` states, with a building-permit number written beside
 * it removed, or null when the value is not a house number.
 */
export function guamHouseNumber(value: string): string | null {
	if (HOUSE_NUMBER.test(value)) return value

	const parts = value
		.split("/")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)

	const numbers = parts.filter((part) => HOUSE_NUMBER.test(part))

	if (numbers.length === 1 && parts.every((part) => numbers.includes(part) || PERMIT_NUMBER.test(part))) {
		return numbers[0]!
	}

	return null
}

/**
 * The street types `STR_TYPE` writes, as the layer abbreviates or spells them.
 */
const STREET_TYPES: ReadonlySet<string> = new Set([
	"ST",
	"STREET",
	"HWY",
	"HIGHWAY",
	"RD",
	"ROAD",
	"CT",
	"CRT",
	"COURT",
	"DR",
	"DRIVE",
	"LN",
	"LANE",
	"AVE",
	"AVENUE",
	"LOOP",
	"LP",
	"WAY",
	"WY",
	"CIR",
	"CIRCLE",
	"BLVD",
	"BOULEVARD",
	"PL",
])

const DIRECTIONS: ReadonlySet<string> = new Set(["N", "S", "E", "W"])

/**
 * Maps one record onto the components the corpus asserts, or returns null when the row is refused.
 *
 * Each refusal and each dropped component increments its reason in `dropped`.
 */
export function componentsForGuamRecord(
	record: GuamAddressPointRecord,
	dropped?: Pick<AdapterOptions, "dropped">
): CanonicalRow["components"] | null {
	const tally = dropped ?? {}
	const written = present(record.HOUSE_NUM)

	if (!written) {
		countDropped(tally, "row:no-house-number")

		return null
	}

	const houseNumber = guamHouseNumber(written)

	if (!houseNumber) {
		countDropped(tally, "row:house-number-not-a-number")

		return null
	}

	const name = present(record.STREETNAME)
	const street = name ?? present(record.FullRdNm)

	if (!street) {
		countDropped(tally, "row:no-street")

		return null
	}

	if (/^\(?OFF OF\b/iu.test(street)) {
		countDropped(tally, "row:street-off-of")

		return null
	}

	if (/[/()]/u.test(street)) {
		countDropped(tally, "row:street-names-two-roads")

		return null
	}

	const components: CanonicalRow["components"] = { house_number: houseNumber, street }

	// `FullRdNm` already holds the direction and the type, so they are read beside `STREETNAME` only.
	if (name) {
		const direction = present(record.PRE_DIR)?.toUpperCase()

		if (direction && DIRECTIONS.has(direction)) {
			if (upperFold(name).startsWith(`${direction} `)) {
				countDropped(tally, "component:street_prefix:repeats-street")
			} else {
				components.street_prefix = direction
			}
		} else if (direction) {
			countDropped(tally, "component:street_prefix:not-a-direction")
		}

		const type = present(record.STR_TYPE)?.toUpperCase().replace(/\.$/u, "")

		if (type && STREET_TYPES.has(type)) {
			if (upperFold(name).endsWith(` ${type}`)) {
				countDropped(tally, "component:street_suffix:repeats-street")
			} else {
				components.street_suffix = type
			}
		} else if (type) {
			countDropped(tally, "component:street_suffix:not-a-street-type")
		}
	}

	const unit = present(record.UNIT)

	if (unit && /^[A-Z0-9]{1,4}$/u.test(unit)) {
		// `HOUSE_NUM` sometimes writes the unit letter after the number as well (`155 A` with unit `A`).
		if (houseNumber.endsWith(` ${unit}`) || (/^[A-Z]$/u.test(unit) && houseNumber.endsWith(unit))) {
			countDropped(tally, "component:unit:repeats-house-number")
		} else {
			components.unit = unit
		}
	} else if (unit) {
		countDropped(tally, "component:unit:not-a-unit-designator")
	}

	const city = present(record.CITY)
	const place = present(record.PLACENAME)

	if (city && isGuamPlaceName(city)) {
		components.locality = city
	} else if (city) {
		countDropped(tally, "component:locality:not-a-guam-place")
	} else if (place && isGuamPlaceName(place)) {
		components.locality = place
	}

	if (!components.locality) {
		countDropped(tally, "row:no-locality")

		return null
	}

	return components
}

/**
 * The GeoJSON pages an input names: the file itself, or every `.geojson` in a directory, in name order.
 */
async function pageFiles(inputPath: string): Promise<string[]> {
	const stat = await tryStat(inputPath)

	if (!stat?.isDirectory()) return [inputPath]

	const names = await Globerator.from("*.geojson", { cwd: inputPath, absolute: false }).toSorted()

	return names.map((name) => `${inputPath}/${name}`)
}

export function createGuamAddressPointsAdapter(): CorpusAdapter {
	return {
		id: BSP_GU_ADAPTER_ID,
		defaultLicense: BSP_GU_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.GuamAddressPoints,
		surface: SurfaceOrigin.Rendered,
		description:
			"Address_Point_(Public_View) (Government of Guam, Bureau of Statistics & Plans GIS): Guam's address points.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !BSP_GU_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(BSP_GU_ADAPTER_ID, BSP_GU_COUNTRIES, opts.country)
			}

			let emitted = 0

			for (const file of await pageFiles(resolvePath(opts.inputPath))) {
				// A query page holds at most the layer's 2,000-feature maxRecordCount, so each is parsed whole.
				const collection = parseJSONStrict<GuamFeatureCollection>(await readLocalTextFile(file))

				if (!Array.isArray(collection.features)) {
					throw new TypeError(`${BSP_GU_ADAPTER_ID} adapter: ${file} holds no GeoJSON features array`)
				}

				for (const feature of collection.features) {
					if (opts.signal?.aborted) return

					if (typeof opts.limit === "number" && emitted >= opts.limit) return

					const record = feature.properties

					if (!record) {
						countDropped(opts, "row:no-properties")

						continue
					}

					const components = componentsForGuamRecord(record, opts)

					if (!components) continue

					const rendered = formatAddressRow(components, "GU", { singleLine: true })

					if (!rendered) {
						countDropped(opts, "row:render-failed")

						continue
					}

					for (const tag of rendered.unplaced) {
						countDropped(opts, `component:${tag}:not-rendered`)
					}

					const { raw, components: aligned } = rendered
					const [lon, lat] = feature.geometry?.coordinates ?? []

					yield {
						raw,
						components: aligned,
						country: "GU",
						locale: "en-GU",
						source: BSP_GU_ADAPTER_ID,
						// `FID` is the layer's object id, unique per feature.
						// The point separates the units of one building that the rendered components may not.
						source_id: stableSourceIDFromParts(BSP_GU_ADAPTER_ID, {
							...aligned,
							fid: present(record.FID) ?? "",
							lat: typeof lat === "number" ? String(lat) : "",
							lon: typeof lon === "number" ? String(lon) : "",
						}),
						corpus_version: "",
						license: BSP_GU_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const guamAddressPointsAdapter = createGuamAddressPointsAdapter()
