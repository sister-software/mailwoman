/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which inputs a measurement runs over, and what that choice costs.
 *
 *   The design rule (spec §5.1) is that the well-powered thing must be the CHEAPEST thing to type. `{kind:"board"}` is
 *   the shortest legal value and it is the default everywhere; a hand-picked list requires an array AND a `why` string,
 *   so choosing a small sample is a deliberate act that leaves a record in the result. This inverts the incentive that
 *   produced nine one-off probe scripts in a day, each with a panel its author chose and nobody reviewed.
 *
 *   Every resolved set carries its `sha256`, its selection kind and — where it is a subset — the size of the set it was
 *   drawn from, because a denominator that travels with the number is the only kind that survives a relay.
 */

import { createHash } from "node:crypto"

import { loadRegressionCases, regressionCorpusHash } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"

import type { Selection } from "./power.ts"

/**
 * A reference to an input set. Discriminated so a caller cannot pass a bare array by accident — see the module
 * docstring for why the hand-picked case is deliberately the wordy one.
 */
export type InputSetRef =
	| { kind: "board"; country?: string; address_kind?: string; status?: string }
	| { kind: "literal"; inputs: string[]; why: string }

export interface ResolvedInput {
	/**
	 * Case id for a board row; for a literal input, the input's own index. Carried so a result row can be traced back.
	 */
	id: string
	input: string
	country?: string
	addressKind?: string
	status?: string
	/**
	 * The case's expectations, when it has any. Present so a caller can grade; absent for literal inputs, which have no
	 * truth attached and therefore cannot be graded — only observed.
	 */
	seed?: SeedCase
}

export interface ResolvedInputSet {
	setID: string
	inputs: ResolvedInput[]
	n: number
	sha256: string
	selection: Selection
	/**
	 * Size of the set this was drawn from, when this is a subset. `undefined` for a full board.
	 */
	populationN?: number
	/**
	 * Required and echoed for a hand-picked set. It appears in every result derived from the set, so the reason for a
	 * small panel is visible next to the number it produced.
	 */
	why?: string
	/**
	 * Strata present in the population but ABSENT from this set — the answer to "what would this panel have been blind
	 * to?", available before the run rather than after. Empty for a full board.
	 */
	notCovered: string[]
	/**
	 * How many rows carry each kind of truth. A set with no coordinate truth cannot be graded on distance however many
	 * rows it has, and saying so is cheaper than discovering it in a table of nulls.
	 */
	hasTruth: { components: number; coordinates: number; tier: number; none: number }
	/**
	 * The live corpus hash, for a board-derived set. Recomputed on every resolve and never cached: a cached stamp verdict
	 * is the 2026-08-06 failure with extra steps.
	 */
	corpusHash?: string
	notes: string[]
}

function sha256(values: string[]): string {
	return createHash("sha256").update(values.join("\n")).digest("hex")
}

function countStrata(cases: SeedCase[], pick: (c: SeedCase) => string | undefined): Map<string, number> {
	const counts = new Map<string, number>()

	for (const row of cases) {
		const key = pick(row)

		if (!key) continue

		counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	return counts
}

function truthCounts(cases: SeedCase[]): ResolvedInputSet["hasTruth"] {
	let components = 0
	let coordinates = 0
	let tier = 0
	let none = 0

	for (const row of cases) {
		const hasComponents = Boolean(row.expectComponents || row.expectComponentRenderings)
		const hasCoordinates = typeof row.expectLat === "number" && typeof row.expectLon === "number"
		const hasTier = Boolean(row.expectTier)

		if (hasComponents) {
			components++
		}
		if (hasCoordinates) {
			coordinates++
		}
		if (hasTier) {
			tier++
		}
		if (!hasComponents && !hasCoordinates && !hasTier) {
			none++
		}
	}

	return { components, coordinates, tier, none }
}

/**
 * Resolve a reference into the rows it names.
 *
 * A board slice reports what it excluded, not merely what it kept. That asymmetry is the point: a caller who filters to
 * `country: "gb"` is told which countries just left the measurement, in the same object that carries the result.
 */
export async function resolveInputSet(ref: InputSetRef): Promise<ResolvedInputSet> {
	if (ref.kind === "literal") {
		if (!ref.inputs.length) throw new Error("input set: a literal set needs at least one input")

		if (!ref.why?.trim()) {
			throw new Error(
				"input set: a literal set requires `why`. A hand-picked panel is a claim about what is worth measuring, " +
					"and the claim is recorded next to every number the set produces."
			)
		}

		return {
			setID: `literal:${sha256(ref.inputs).slice(0, 12)}`,
			inputs: ref.inputs.map((input, index) => ({ id: String(index), input })),
			n: ref.inputs.length,
			sha256: sha256(ref.inputs),
			selection: "hand-picked",
			why: ref.why,
			notCovered: [],
			hasTruth: { components: 0, coordinates: 0, tier: 0, none: ref.inputs.length },
			notes: [
				"Hand-picked inputs carry no expectations, so this set can be observed but not graded.",
				"Results from this set report their confidence bound in the summary sentence — see power.ts.",
			],
		}
	}

	const all = await loadRegressionCases()
	const corpusHash = regressionCorpusHash(all)

	const filtered = all.filter((row) => {
		if (ref.country && row.country.toLowerCase() !== ref.country.toLowerCase()) return false

		if (ref.address_kind && row.addressKind !== ref.address_kind) return false

		if (ref.status && row.status !== ref.status) return false

		return true
	})

	const isSlice = filtered.length !== all.length
	const notCovered: string[] = []

	if (isSlice) {
		const keptCountries = new Set(filtered.map((r) => r.country))
		const droppedCountries = [...new Set(all.map((r) => r.country))].filter((c) => !keptCountries.has(c))
		const keptKinds = new Set(filtered.map((r) => r.addressKind))
		const droppedKinds = [...countStrata(all, (r) => r.addressKind).keys()].filter((k) => !keptKinds.has(k))

		if (droppedCountries.length) {
			notCovered.push(`countries excluded: ${droppedCountries.toSorted().join(", ")}`)
		}
		if (droppedKinds.length) {
			notCovered.push(`address kinds excluded: ${droppedKinds.toSorted().join(", ")}`)
		}
	}

	const slugParts = [ref.country, ref.address_kind, ref.status].filter(Boolean)

	return {
		setID: slugParts.length ? `board:${slugParts.join("/")}` : "board",
		inputs: filtered.map((seed) => ({
			id: seed.id,
			input: seed.input,
			country: seed.country,
			addressKind: seed.addressKind,
			status: seed.status,
			seed,
		})),
		n: filtered.length,
		sha256: sha256(filtered.map((r) => `${r.id}\t${r.input}`)),
		selection: isSlice ? "slice" : "full",
		...(isSlice ? { populationN: all.length } : {}),
		notCovered,
		hasTruth: truthCounts(filtered),
		corpusHash,
		notes: isSlice
			? [`Declared slice of the ${all.length}-row board.`]
			: [`The full regression board, ${all.length} rows, corpus ${corpusHash.slice(0, 12)}.`],
	}
}
