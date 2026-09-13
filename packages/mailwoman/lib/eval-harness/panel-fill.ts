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
	 * Rows skipped because the identity join produced no coherent gold set. The gold reader's own census says WHICH part
	 * of the guard refused them.
	 */
	droppedUngradeableGold: number
	/**
	 * Rows the stratum's own rule could not render. Counted apart from the gold drop because the two name different holes
	 * — one in the gazetteer, one in the source register.
	 */
	droppedUnbuildable: number
}

/**
 * A seeded Fisher-Yates over a copy, so the caller's array is untouched and two runs draw identically.
 *
 * The ORDER this returns is what selects the rows a frozen panel contains, and a published record names that panel's
 * digest. `SeededRandom.shuffle` reproduces the loop this used to spell out — verified identical over sizes 24, 1,000,
 * 10,932 and 100,000, at seeds 1, 7, 20260913 and 4294967295.
 */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const shuffled = [...items]

	new SeededRandom(seed).shuffle(shuffled)

	return shuffled
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

	for (const item of seededShuffle(eligible, seed)) {
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
