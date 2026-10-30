/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Renders a Korean address in one of seven registers and decides which registers a row supports.
 *
 *   A register is one way to write an address: the ministry form, typed, delivery, the spoken short region, search
 *   without spaces, or the lot-number form. `short_region` needs a known short form, `official` and `building` need
 *   the parenthetical, and `jibun` needs a lot with its 동.
 *
 *   Ported from the Python builders' `countries/kr/corpora/rows.py`.
 */

import { codePointLength } from "@mailwoman/core/strings/code-points"
import { splitWhitespace } from "@mailwoman/core/strings/unicode"

import { type CJKRecord, labelTokensByFirstSpan, MAX_RENDERED_CHARS, RowRenderer } from "#cjk/builder"
import { normalizeCJKText } from "#cjk/text"
import { type JusoLabelRow, parenthetical, REGION_ALIASES } from "#kr/adapters/juso/label-rows"
import { type Aligned, alignLotAddress, alignRoadAddress } from "#kr/adapters/localdata/align"
import type { KeyIndex } from "#kr/adapters/localdata/key-index"
import { alignedToCJKRow, type PermitRow } from "#kr/adapters/localdata/permit-rows"
import type { PyRandom } from "#training/pyrandom"

/**
 * The label set Korean rows are tagged against.
 */
export const KR_LABEL_SET_NAME = "stage3-cjk"

/**
 * The corpus source of the register rows.
 */
export const KR_CORPUS_SOURCE = "juso-kr"

/**
 * The corpus source of the aligned permit rows.
 */
export const KR_REGISTRY_SOURCE = "localdata-kr"

const COUNTRY = "KR"
const COUNTRY_NAME = "대한민국"

/**
 * The spoken and typed short forms of each 시·도.
 * A region absent here has no `short_region` register.
 */
const SHORT_REGIONS: Readonly<Record<string, readonly string[]>> = {
	서울특별시: ["서울시", "서울"],
	부산광역시: ["부산시", "부산"],
	대구광역시: ["대구시", "대구"],
	인천광역시: ["인천시", "인천"],
	광주광역시: ["광주시", "광주"],
	대전광역시: ["대전시", "대전"],
	울산광역시: ["울산시", "울산"],
	세종특별자치시: ["세종시", "세종"],
	경기도: ["경기"],
	강원도: ["강원"],
	강원특별자치도: ["강원도", "강원"],
	충청북도: ["충북"],
	충청남도: ["충남"],
	전라북도: ["전북"],
	전북특별자치도: ["전북"],
	전라남도: ["전남"],
	경상북도: ["경북"],
	경상남도: ["경남"],
	제주특별자치도: ["제주도", "제주"],
}

/**
 * Each register's weight.
 *
 * The sampler renormalizes them over the registers a row can render.
 */
export const KR_REGISTER_WEIGHTS = new Map<string, number>([
	["official", 0.22],
	["building", 0.08],
	["no_dong", 0.2],
	["postcode_first", 0.1],
	["short_region", 0.1],
	["unspaced", 0.08],
	["jibun", 0.22],
])

/**
 * Options for {@linkcode renderKRRow}.
 */
export interface KRRenderOptions {
	register: string
	country?: boolean
	shortRegion?: string | null
}

/**
 * One register row rendered in one register as a span-labeled corpus record.
 *
 * A compound 시군구 (`수원시 장안구`) is two adjacent subregion spans. 세종특별자치시 has no 시군구,
 * so its rows go from the region to the 읍/면 or the road.
 *
 * @throws When the `short_region` register has no short form.
 */
export function renderKRRow(row: JusoLabelRow, options: KRRenderOptions): CJKRecord {
	const renderer = new RowRenderer()
	const { register } = options
	const separator = register === "unspaced" ? "" : " "
	const inParentheses = parenthetical(row)

	if (register === "postcode_first") {
		renderer.put("postcode", row.postcode)
		renderer.glue(" ")
	}

	if (options.country) {
		renderer.put("country", COUNTRY_NAME)
		renderer.glue(separator)
	}

	if (register === "short_region") {
		if (!options.shortRegion) throw new Error("short_region register needs a short region form")

		renderer.put("region", options.shortRegion)
	} else {
		renderer.put("region", row.region)
	}

	renderer.glue(separator)

	for (const [index, unit] of splitWhitespace(row.sigungu).entries()) {
		if (index) {
			renderer.glue(separator)
		}

		renderer.put("subregion", unit)
	}

	if (row.sigungu) {
		renderer.glue(separator)
	}

	if (register === "jibun") {
		renderer.put("dependent_locality", row.dong)

		if (row.ri) {
			renderer.glue(separator)
			renderer.put("dependent_locality", row.ri)
		}

		renderer.glue(separator)
		renderer.put("house_number", row.lot)

		if (row.building) {
			renderer.glue(separator)
			renderer.put("venue", row.building)
		}
	} else {
		if (row.eupmyeon) {
			renderer.put("dependent_locality", row.eupmyeon)
			renderer.glue(separator)
		}

		renderer.put("street", row.road)
		renderer.glue(separator)

		if (row.underground) {
			renderer.glue("지하 ")
		}

		renderer.put("house_number", row.number)

		if ((register === "official" || register === "building") && inParentheses) {
			renderer.glue(" (")
			renderer.put("dependent_locality", inParentheses)

			if (register === "building" && row.building) {
				renderer.glue(", ")
				renderer.put("venue", row.building)
			}

			renderer.glue(")")
		}
	}

	return {
		raw: renderer.raw,
		...labelTokensByFirstSpan(renderer.raw, renderer.starts, renderer.ends, renderer.tags),
		span_starts: renderer.starts,
		span_ends: renderer.ends,
		span_tags: renderer.tags,
		country: COUNTRY,
		source: KR_CORPUS_SOURCE,
		register,
	}
}

/**
 * The registers a row can render.
 */
export function availableKRRegisters(row: JusoLabelRow): string[] {
	const options = new Set(["no_dong", "postcode_first", "unspaced"])

	if (parenthetical(row)) {
		options.add("official")

		if (row.building) {
			options.add("building")
		}
	}

	if (row.region in SHORT_REGIONS) {
		options.add("short_region")
	}

	if (row.dong && row.lot) {
		options.add("jibun")
	}

	return [...KR_REGISTER_WEIGHTS.keys()].filter((name) => options.has(name))
}

/**
 * One of `options`, drawn by {@linkcode KR_REGISTER_WEIGHTS}.
 * A single option is returned without a draw.
 */
export function chooseKRRegister(rng: PyRandom, options: readonly string[]): string {
	if (options.length === 1) return options[0]!

	return rng.choices(options, { weights: options.map((name) => KR_REGISTER_WEIGHTS.get(name)!) })[0]!
}

/**
 * One of a region's short forms, or `null` without a draw when it has none.
 */
export function chooseShortRegion(rng: PyRandom, region: string): string | null {
	const forms = SHORT_REGIONS[region]

	return forms?.length ? rng.choice(forms) : null
}

/**
 * Why a register row is dropped, or `null` when it renders.
 *
 * 시군구 is not required, because 세종특별자치시 has none.
 */
export function krIneligibility(row: JusoLabelRow, maxFieldChars: number): string | null {
	if (!(row.region && row.road && row.number && row.postcode)) return "missing_field"

	if (
		[row.region, row.sigungu, row.road, row.number, row.building].some(
			(value) => codePointLength(value) > maxFieldChars
		)
	) {
		return "field_too_long"
	}

	if (row.sigungu.split(" ").length - 1 > 1 || row.road.includes(" ") || row.number.includes(" ")) {
		return "whitespace_shape"
	}

	return null
}

/**
 * The centroid and hold-out key: the register's current region name,
 * so a pre-merger permit row keys the same unit.
 */
export function krHoldoutKey(region: string, sigungu: string): string {
	return normalizeCJKText(`${REGION_ALIASES[region] ?? region}|${sigungu}`)
}

/**
 * An aligned permit string as a registry corpus record.
 */
export function krRegistryRecord(aligned: Aligned): CJKRecord {
	return { ...alignedToCJKRow(aligned), source: KR_REGISTRY_SOURCE }
}

/**
 * Every form of one permit that aligns and fits the model's window.
 *
 * A clerk's 99-character unit list would be truncated by the loader, so it is a board row instead.
 */
export function krPermitAlignment(row: PermitRow, index: KeyIndex): Aligned[] {
	const out: Aligned[] = []

	if (row.roadAddress) {
		const road = alignRoadAddress(row.roadAddress, index)

		if (road && codePointLength(road.raw) <= MAX_RENDERED_CHARS) {
			out.push(road)
		}
	}

	if (row.lotAddress) {
		const lot = alignLotAddress(row.lotAddress, index)

		if (lot && codePointLength(lot.raw) <= MAX_RENDERED_CHARS) {
			out.push(lot)
		}
	}

	return out
}
