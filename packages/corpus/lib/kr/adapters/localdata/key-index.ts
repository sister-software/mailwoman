/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The address register's key sets, the only thing a permit string is allowed to align against; the
 * permit registry's address field is an `observation` a clerk typed without validation, so every part
 * of a string — 시도, 시군구, road, 동, 리 — must be one the register lists under its parent.
 */

import { type JusoLabelRow, REGION_ALIASES } from "#kr/adapters/juso/label-rows"

/**
 * The separator between the parts of a composite key, written as an escape so no NUL byte
 * enters the source; a space cannot serve, because a 시군구 is written with one (`수원시 장안구`)
 * and `unitKey("A", "B C")` would collide with `unitKey("A B", "C")`.
 */
const UNIT_SEPARATOR = "\0"

/**
 * The key sets keyed as the register nests them, as composite string keys rather than
 * nested maps, because a nested map costs a second lookup on the hot path.
 */
export interface KeyIndex {
	regions: Set<string>
	/**
	 * 시도 → its 시군구 names.
	 */
	sigunguByRegion: Map<string, Set<string>>
	/**
	 * 시도 and 시군구 → the unit's road names.
	 */
	roadsByUnit: Map<string, Set<string>>
	/**
	 * 시도 and 시군구 → the unit's 동 and 읍/면 names.
	 */
	dongsByUnit: Map<string, Set<string>>
	/**
	 * 시도, 시군구 and 동 → the 동's 리 names.
	 */
	risByDong: Map<string, Set<string>>
}

/**
 * The parts of a composite key, joined so no two different part lists produce the same key.
 */
export function unitKey(...parts: readonly string[]): string {
	return parts.join(UNIT_SEPARATOR)
}

export function emptyKeyIndex(): KeyIndex {
	return {
		regions: new Set(),
		sigunguByRegion: new Map(),
		roadsByUnit: new Map(),
		dongsByUnit: new Map(),
		risByDong: new Map(),
	}
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
	const existing = map.get(key)

	if (existing) {
		existing.add(value)
	} else {
		map.set(key, new Set([value]))
	}
}

/**
 * Add one label row's names to the key sets; the 읍/면 joins the unit's 동 set as a road-form
 * token, since the road address writes it between the 시군구 and the road.
 */
export function indexLabelRow(index: KeyIndex, row: JusoLabelRow): void {
	index.regions.add(row.region)
	add(index.sigunguByRegion, row.region, row.sigungu)

	const unit = unitKey(row.region, row.sigungu)

	add(index.roadsByUnit, unit, row.road)

	if (row.eupmyeon) {
		add(index.dongsByUnit, unit, row.eupmyeon)
	}

	if (row.dong) {
		add(index.dongsByUnit, unit, row.dong)

		if (row.ri) {
			add(index.risByDong, unitKey(row.region, row.sigungu, row.dong), row.ri)
		}
	}
}

/**
 * Admit the pre-merger region names as aliases of the register's current one, sharing its
 * sets by reference so a later `indexLabelRow` under either name reaches the same set.
 */
export function aliasKeyIndex(index: KeyIndex): void {
	for (const [legacy, current] of Object.entries(REGION_ALIASES)) {
		if (!index.regions.has(current)) continue

		index.regions.add(legacy)

		const sigungu = index.sigunguByRegion.get(current)

		if (sigungu) {
			index.sigunguByRegion.set(legacy, sigungu)
		}

		// oxlint-disable no-useless-spread -- each loop writes into the map it reads, so it walks a snapshot.
		for (const [key, roads] of [...index.roadsByUnit]) {
			const [region, unit] = key.split(UNIT_SEPARATOR)

			if (region === current) {
				index.roadsByUnit.set(unitKey(legacy, unit!), roads)
			}
		}

		for (const [key, dongs] of [...index.dongsByUnit]) {
			const [region, unit] = key.split(UNIT_SEPARATOR)

			if (region === current) {
				index.dongsByUnit.set(unitKey(legacy, unit!), dongs)
			}
		}

		for (const [key, ris] of [...index.risByDong]) {
			const [region, unit, dong] = key.split(UNIT_SEPARATOR)

			if (region === current) {
				index.risByDong.set(unitKey(legacy, unit!, dong!), ris)
			}
		}
		// oxlint-enable no-useless-spread
	}
}

/**
 * How many tokens from `start` form one of the region's 시군구 — 2 for `수원시 장안구`,
 * 1 for `종로구`, 0 for none; two-token first, because `수원시` alone is also listed
 * and taking it would leave `장안구` to be read as a road.
 */
export function sigunguSpan(index: KeyIndex, region: string, tokens: readonly string[], start: number): number {
	const candidates = index.sigunguByRegion.get(region)

	if (!candidates) return 0

	for (const width of [2, 1]) {
		if (start + width <= tokens.length && candidates.has(tokens.slice(start, start + width).join(" "))) {
			return width
		}
	}

	return 0
}

/**
 * The key sets the permit aligner reads, from one pass over the register rows.
 */
export async function buildKeyIndex(rows: AsyncIterable<JusoLabelRow>): Promise<KeyIndex> {
	const index = emptyKeyIndex()

	for await (const row of rows) {
		indexLabelRow(index, row)
	}

	aliasKeyIndex(index)

	return index
}
