/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Align one permit-registry address string to the LABEL register's key, or answer null (#2204 §5).
 *
 *   Every permit row carries the same premises in both address systems, typed by a clerk:
 *
 *       도로명주소  서울특별시 종로구 종로 233, 1층 일부호 (종로5가)
 *       지번주소    서울특별시 종로구 종로5가 43-1
 *
 *   The road-name form is `<시도> <시군구> <도로명> <건물번호>`, then an optional `, <상세주소>` (floor, unit, building)
 *   and an optional parenthetical `(<법정동>[, <건물명>])`; the lot-number form is
 *   `<시도> <시군구> <법정동> [<리>] [산]<본번>[-<부번>]` followed by whatever the clerk added.
 *
 *   ALIGNMENT IS EXACT against {@link KeyIndex}, never fuzzy. A string that satisfies the whole key becomes a training
 *   row whose spans are the matched pieces; one that does not is a BOARD row — an address the model will be read on and
 *   never trained on. The rate per file is measured and reported before any row enters a corpus, which is the rule a
 *   noisy source is admitted under.
 */

import { type KeyIndex, sigunguSpan, unitKey } from "#adapters/localdata-kr/key-index"

/**
 * A building number: `233`, `43-1`, `지하 1476`.
 */
const BUILDING_NUMBER = /^(?:지하\s?)?\d+(?:-\d+)?$/u

/**
 * A lot number: `43-1`, `산12`, `43번지`.
 */
const LOT_NUMBER = /^산?\d+(?:-\d+)?(?:번지)?$/u

/**
 * A floor or unit the clerk appended: `2층`, `일부호`, `B1`, `지하1층`, `101동`.
 */
const UNIT_TOKEN = /^(?:지하\s?)?(?:B?\d+(?:~\d+)?(?:층|호)|\d+층|B\d+|지하\d*층?|\d+동|[가-힣]?\d*호)(?:,)?$/u

/**
 * The shortest either form can be: 시도, 시군구, and the road or the 법정동. Anything shorter cannot carry the key, whatever
 * else it holds.
 */
const MINIMUM_TOKENS = 3

/**
 * One aligned string: the spans that matched, and the key they matched under.
 */
export interface Aligned {
	raw: string
	spanStarts: number[]
	spanEnds: number[]
	spanTags: string[]
	register: "registry_road" | "registry_lot"
	region: string
	sigungu: string
}

interface Span {
	start: number
	end: number
	tag: string
}

/**
 * Record a span, unless it is empty or blank.
 *
 * A blank span is what a clerk's double space produces, and a zero-width one what a token found at its own end
 * produces; neither is a component and both would train the model on nothing.
 */
function put(spans: Span[], text: string, start: number, end: number, tag: string): void {
	if (end > start && text.slice(start, end).trim()) {
		spans.push({ start, end, tag })
	}
}

/**
 * Where each token begins in the original text, walked left to right so a repeated token takes its own position rather
 * than the first one's.
 */
function tokenPositions(text: string, tokens: readonly string[], from = 0): number[] {
	const positions: number[] = []
	let cursor = from

	for (const token of tokens) {
		const at = text.indexOf(token, cursor)

		positions.push(at)
		cursor = at + token.length
	}

	return positions
}

/**
 * The index of the first unit-shaped token, or the length when there is none.
 */
function firstUnitIndex(tokens: readonly string[]): number {
	const found = tokens.findIndex((token) => UNIT_TOKEN.test(token))

	return found === -1 ? tokens.length : found
}

function finish(text: string, spans: Span[], register: Aligned["register"], region: string, sigungu: string): Aligned {
	const sorted = spans.toSorted((a, b) => a.start - b.start || a.end - b.end || a.tag.localeCompare(b.tag))

	return {
		raw: text,
		spanStarts: sorted.map((span) => span.start),
		spanEnds: sorted.map((span) => span.end),
		spanTags: sorted.map((span) => span.tag),
		register,
		region,
		sigungu,
	}
}

/**
 * Align one road-name string, or answer null.
 */
export function alignRoadAddress(text: string, index: KeyIndex): Aligned | null {
	const openAt = text.indexOf("(")
	const head = openAt === -1 ? text : text.slice(0, openAt)
	const tail = openAt === -1 ? "" : text.slice(openAt + 1)
	const parenthetical = tail.endsWith(")") ? tail.slice(0, -1).trim() : ""

	const commaAt = head.indexOf(",")
	const core = commaAt === -1 ? head : head.slice(0, commaAt)
	const detail = commaAt === -1 ? "" : head.slice(commaAt + 1)

	const tokens = core.split(/\s+/u).filter((token) => token.length)
	const positions = tokenPositions(text, tokens)

	if (tokens.length < MINIMUM_TOKENS || !index.regions.has(tokens[0]!)) return null

	const region = tokens[0]!
	const width = sigunguSpan(index, region, tokens, 1)

	// A region with no 시군구 level (세종특별자치시) lists the empty string; its strings go region → road.
	if (!width && !index.sigunguByRegion.get(region)?.has("")) return null

	const sigungu = tokens.slice(1, 1 + width).join(" ")
	const unit = unitKey(region, sigungu)
	const roads = index.roadsByUnit.get(unit) ?? new Set<string>()
	const dongs = index.dongsByUnit.get(unit) ?? new Set<string>()

	let roadAt = 1 + width
	let eupmyeonAt: number | null = null

	// In an 읍/면 area the road form carries the 읍/면 between the 시군구 and the road (`기장군 기장읍 기장해안로 205`); the
	// register lists those names beside the 동 of the same unit.
	if (roadAt + 2 < tokens.length && dongs.has(tokens[roadAt]!) && roads.has(tokens[roadAt + 1]!)) {
		eupmyeonAt = roadAt
		roadAt += 1
	}

	// A road name is one token; a numbered branch (`대학로8길`) is part of that token in the register.
	if (roadAt + 1 >= tokens.length || !roads.has(tokens[roadAt]!)) return null

	let numberAtToken = roadAt + 1

	// `달구벌대로 지하 1476`: the underground marker stands as its own token before the number, outside every span.
	if (tokens[numberAtToken] === "지하" && numberAtToken + 1 < tokens.length) {
		numberAtToken += 1
	}

	const number = tokens[numberAtToken]!

	if (!BUILDING_NUMBER.test(number)) return null

	const spans: Span[] = []

	put(spans, text, positions[0]!, positions[0]! + region.length, "region")

	for (let offset = 0; offset < width; offset += 1) {
		const token = tokens[1 + offset]!

		put(spans, text, positions[1 + offset]!, positions[1 + offset]! + token.length, "subregion")
	}

	if (eupmyeonAt !== null) {
		put(spans, text, positions[eupmyeonAt]!, positions[eupmyeonAt]! + tokens[eupmyeonAt]!.length, "dependent_locality")
	}

	put(spans, text, positions[roadAt]!, positions[roadAt]! + tokens[roadAt]!.length, "street")

	const numberAt = positions[numberAtToken]!

	put(spans, text, numberAt, numberAt + number.length, "house_number")

	// What follows the number, with or without a comma, is the building name and then the floor/unit — the same
	// leading-venue, unit-tail reading the lot form uses.
	const restTokens = [...tokens.slice(numberAtToken + 1), ...detail.split(/\s+/u).filter((token) => token.length)]

	if (restTokens.length) {
		const restPositions = tokenPositions(text, restTokens, numberAt + number.length)
		const firstUnit = firstUnitIndex(restTokens)

		if (firstUnit) {
			put(spans, text, restPositions[0]!, restPositions[firstUnit - 1]! + restTokens[firstUnit - 1]!.length, "venue")
		}

		if (firstUnit < restTokens.length) {
			put(spans, text, restPositions[firstUnit]!, restPositions.at(-1)! + restTokens.at(-1)!.length, "unit")
		}
	}

	if (parenthetical) {
		const parenAt = text.indexOf(parenthetical, head.length)
		const innerComma = parenthetical.indexOf(",")
		const dong = (innerComma === -1 ? parenthetical : parenthetical.slice(0, innerComma)).trim()
		const building = (innerComma === -1 ? "" : parenthetical.slice(innerComma + 1)).trim()

		if (dongs.has(dong)) {
			const dongAt = text.indexOf(dong, parenAt)

			put(spans, text, dongAt, dongAt + dong.length, "dependent_locality")

			if (building) {
				const buildingAt = text.indexOf(building, dongAt + dong.length)

				put(spans, text, buildingAt, buildingAt + building.length, "venue")
			}
		} else {
			put(spans, text, parenAt, parenAt + parenthetical.length, "venue")
		}
	}

	return finish(text, spans, "registry_road", region, sigungu)
}

/**
 * Align one lot-number string, or answer null.
 */
export function alignLotAddress(text: string, index: KeyIndex): Aligned | null {
	const tokens = text.split(/\s+/u).filter((token) => token.length)
	const positions = tokenPositions(text, tokens)

	if (tokens.length < MINIMUM_TOKENS || !index.regions.has(tokens[0]!)) return null

	const region = tokens[0]!
	const width = sigunguSpan(index, region, tokens, 1)

	if (!width && !index.sigunguByRegion.get(region)?.has("")) return null

	const sigungu = tokens.slice(1, 1 + width).join(" ")
	const dongAt = 1 + width
	const dongs = index.dongsByUnit.get(unitKey(region, sigungu)) ?? new Set<string>()

	if (dongAt >= tokens.length || !dongs.has(tokens[dongAt]!)) return null

	const dong = tokens[dongAt]!
	let lotAt = dongAt + 1
	let ri: string | null = null

	if (lotAt < tokens.length && index.risByDong.get(unitKey(region, sigungu, dong))?.has(tokens[lotAt]!)) {
		ri = tokens[lotAt]!
		lotAt += 1
	}

	if (lotAt >= tokens.length || !LOT_NUMBER.test(tokens[lotAt]!)) return null

	const lot = tokens[lotAt]!
	const spans: Span[] = []

	put(spans, text, positions[0]!, positions[0]! + region.length, "region")

	for (let offset = 0; offset < width; offset += 1) {
		const token = tokens[1 + offset]!

		put(spans, text, positions[1 + offset]!, positions[1 + offset]! + token.length, "subregion")
	}

	put(spans, text, positions[dongAt]!, positions[dongAt]! + dong.length, "dependent_locality")

	if (ri) {
		put(spans, text, positions[lotAt - 1]!, positions[lotAt - 1]! + ri.length, "dependent_locality")
	}

	put(spans, text, positions[lotAt]!, positions[lotAt]! + lot.length, "house_number")

	const rest = tokens.slice(lotAt + 1)

	if (rest.length) {
		// The clerk writes the building name first and the floor/unit after it (`교보생명빌딩 2층`, `지강빌딩 1층 일부호`):
		// the venue is the run of tokens before the first unit-shaped one, the unit everything from there to the end.
		const firstUnit = firstUnitIndex(rest)

		if (firstUnit) {
			put(spans, text, positions[lotAt + 1]!, positions[lotAt + firstUnit]! + rest[firstUnit - 1]!.length, "venue")
		}

		if (firstUnit < rest.length) {
			put(spans, text, positions[lotAt + 1 + firstUnit]!, positions[lotAt + rest.length]! + rest.at(-1)!.length, "unit")
		}
	}

	return finish(text, spans, "registry_lot", region, sigungu)
}
