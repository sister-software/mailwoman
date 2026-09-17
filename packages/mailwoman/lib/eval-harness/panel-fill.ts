/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Filling one stratum of a pre-registered panel: shuffle the eligible rows once with the registered seed,
 *   take in order until the target is reached, and report what was dropped and why.
 *
 *   Shared by every stratified benchmark here, because the part that must not vary between them is the part a
 *   second copy would get subtly wrong — the draw ORDER decides which rows a frozen panel contains, and a
 *   stratum that counted its own drops differently would report a coverage hole as a panel choice.
 *
 *   A stratum decides for itself whether a row is gradeable, because the gold is not always the row being
 *   iterated: the same-data homograph rule alternates between two bearers, and a check against the iterated
 *   one would refuse rows whose actual gold is fine.
 */

import { SeededRandom } from "@mailwoman/core/random"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"

/**
 * What a stratum's own rule made of one eligible row.
 */
export type StratumOutcome<Row> =
	| { readonly outcome: "row"; readonly row: Row }
	| { readonly outcome: "ungradeable" }
	| { readonly outcome: "unbuildable" }

/**
 * What the build dropped and why — reported beside the panel, never folded into it.
 */
export interface StratumFillCensus {
	stratum: string
	eligible: number
	selected: number
	/**
	 * Rows skipped because the identity join produced no coherent gold set. The gold reader's own census says which part
	 * of the guard refused them.
	 */
	droppedUngradeableGold: number
	/**
	 * Rows the stratum's own rule could not render. Counted apart from the gold drop because the two name different holes
	 * — one in the gazetteer, one in the source register.
	 */
	droppedUnbuildable: number
}

export interface FillStratumOptions<Item, Row> {
	stratum: string
	eligible: readonly Item[]
	seed: number
	target: number
	/**
	 * The identity a stratum marks used, so a later stratum drawing from the same register cannot take the row again.
	 */
	identify: (item: Item) => string
	/**
	 * Identities already taken. Mutated as rows are selected, so strata fill in order against one set.
	 */
	used: Set<string>
	build: (item: Item, index: number) => StratumOutcome<Row>
}

/**
 * Fill one stratum, and report the census beside it.
 */
export function fillStratum<Item, Row>(
	options: FillStratumOptions<Item, Row>
): {
	rows: Row[]
	census: StratumFillCensus
} {
	const { stratum, eligible, seed, target, identify, used, build } = options
	const rows: Row[] = []
	let droppedUngradeableGold = 0
	let droppedUnbuildable = 0

	// A copy, so the caller's array is untouched. The ORDER this walk produces is what selects the rows a frozen panel
	// contains, and a published record names that panel's digest — so the generator is `SeededRandom`'s, seeded the way
	// `SeededRandom` seeds it, rather than a normalisation re-typed here.
	const shuffled = [...eligible]

	new SeededRandom(seed).shuffle(shuffled)

	for (const item of shuffled) {
		if (rows.length >= target) break

		const built = build(item, rows.length)

		if (built.outcome === "ungradeable") {
			droppedUngradeableGold++

			continue
		}

		if (built.outcome === "unbuildable") {
			droppedUnbuildable++

			continue
		}

		rows.push(built.row)
		used.add(identify(item))
	}

	return {
		rows,
		census: {
			stratum,
			eligible: eligible.length,
			selected: rows.length,
			droppedUngradeableGold,
			droppedUnbuildable,
		},
	}
}

/**
 * The zero-padded ordinal a row id carries, so ids sort in draw order.
 */
export function padRowIndex(index: number): string {
	return String(index + 1).padStart(3, "0")
}

/**
 * The register columns a panel builder reads to select and grade a row. `GeoNamesCity` satisfies it; the builders take
 * this shape rather than that type so the grouping and gold helpers below are not tied to one register's reader.
 */
export interface PanelSubject {
	geonameid: string
	name: string
	asciiname: string
	lat: number
	lon: number
	country: string
	admin1: string
	population: number
}

/**
 * Rows grouped by their lowercased ASCII name, which is how both builders ask whether a name is borne once.
 *
 * Built once per build and passed down: the question is asked per candidate row, and re-deriving the grouping for each
 * would walk the whole register every time.
 */
export function groupByFoldedName<Subject extends PanelSubject>(subjects: readonly Subject[]): Map<string, Subject[]> {
	const byName = new Map<string, Subject[]>()

	for (const subject of subjects) {
		const key = subject.asciiname.toLowerCase()
		const bucket = byName.get(key) ?? []

		bucket.push(subject)
		byName.set(key, bucket)
	}

	return byName
}

/**
 * Rows whose name is borne exactly once and which no earlier stratum has taken, in geonameid order.
 *
 * The ORDER matters and is why this is shared rather than re-typed: `fillStratum` shuffles what it is handed, so two
 * builders sorting differently would draw different rows from the same seed. `extra` is the caller's own rule — a
 * population floor, a band — applied before the sort.
 */
export function uniqueNameEligible<Subject extends PanelSubject>(options: {
	subjects: readonly Subject[]
	byName: ReadonlyMap<string, Subject[]>
	used: ReadonlySet<string>
	extra?: (subject: Subject) => boolean
}): Subject[] {
	const { subjects, byName, used, extra } = options

	return subjects
		.filter((subject) => byName.get(subject.asciiname.toLowerCase())!.length === 1)
		.filter((subject) => (extra ? extra(subject) : true))
		.filter((subject) => !used.has(subject.geonameid))
		.toSorted((left, right) => compareByCodePoint(left.geonameid, right.geonameid))
}

/**
 * The gold a panel row carries: the register's own entity and coordinate, plus the identity set the concordance
 * reached. Every benchmark here grades against this shape, so it is written once.
 */
export function goldOf<Subject extends PanelSubject>(subject: Subject, placeIDs: number[]) {
	return {
		geonameid: subject.geonameid,
		placeIDs,
		name: subject.name,
		country: subject.country,
		admin1: subject.admin1,
		lat: subject.lat,
		lon: subject.lon,
		population: subject.population,
	}
}
